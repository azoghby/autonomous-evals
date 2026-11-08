import "server-only";
import { eq, sql } from "drizzle-orm";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { SettleError, VerifyError } from "@x402/core/types";
import { db, schema } from "@ae/core/db/client";
import {
  buildPaymentRequired, buildRequirements, explorerTxUrl, isEvmAddress, isX402SessionKey, payloadMismatch,
  settlementValues, x402Facilitator, x402PayPath, X402_NETWORK, type FacilitatorClient, type PaymentPayload, type SettleResponse, type X402QuoteArgs,
} from "@ae/core/payments/x402";
import { expireOpenCheckout } from "@ae/core/payments/checkout";
import { findX402PaymentForQuote, recordX402Payment } from "@ae/core/payments/x402-store";
import { verifyApiKey } from "./api-keys";
import { getJobForViewer } from "./queries";
import { rateLimit } from "./rate-limit";
import { alertOperators } from "./operator-alerts";
import { withIdempotency, IdempotencyInProgressError, type StoredResponse } from "./idempotency";
import { sendJobEvent } from "@/workflows/events";
import { resumeJobForPayment } from "@/workflows/resume";

const RATE_LIMIT = 30;
const RATE_WINDOW_SEC = 600;
const PAYABLE_STATES = ["quoted", "awaiting_payment"];
const PAID_STATUSES = ["paid", "authorized", "captured"];

/** A failure worth retrying (facilitator/network/DB). Releases the idempotency key and maps to 502/503. */
class TransientError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

/** Money may have moved but we could not record it. Carries the client-facing 502. */
class SettledUnrecordedError extends Error {}
/** A non-success outcome (402 etc.) that must not be cached by the idempotency layer. */
class NonFinalResponse extends Error { constructor(readonly response: StoredResponse) { super("non-final"); } }

const json = (status: number, body: Record<string, unknown>, headers?: Record<string, string>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

/** 402 with the v2 PAYMENT-REQUIRED header and the same object as the JSON body (agents can read either). */
function paymentRequired(args: X402QuoteArgs, error?: string): StoredResponse {
  return { status: 402, body: buildPaymentRequired(args, error) };
}

function toResponse(r: StoredResponse, replayed = false): Response {
  const body = r.body as Record<string, unknown>;
  const headers: Record<string, string> = {};
  if (r.status === 402) headers["PAYMENT-REQUIRED"] = encodePaymentRequiredHeader(body as never);
  const settlement = body?.settlement as SettleResponse | undefined;
  if (r.status === 200 && settlement) headers["PAYMENT-RESPONSE"] = encodePaymentResponseHeader(settlement);
  if (replayed) headers["Idempotent-Replayed"] = "true";
  return json(r.status, body, headers);
}

function readPaymentHeader(req: Request): string | null {
  return req.headers.get("payment-signature") ?? req.headers.get("x-payment");
}

function decodePayload(header: string): PaymentPayload | null {
  try {
    const p = decodePaymentSignatureHeader(header);
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

export interface X402PayDeps { facilitator: () => FacilitatorClient }
const defaultDeps: X402PayDeps = { facilitator: x402Facilitator };

/**
 * POST /api/x402/jobs/:jobId/pay. API-key auth (same keys as MCP). Without a payment header: 402 with x402 v2
 * requirements for the job's latest quote. With PAYMENT-SIGNATURE (or legacy X-PAYMENT): exact-match check,
 * facilitator verify + settle, record the payment (idempotent on tx hash) and resume the job like Stripe does.
 */
export async function handleX402Pay(req: Request, jobId: string, deps: X402PayDeps = defaultDeps): Promise<Response> {
  const payTo = process.env.X402_PAY_TO?.trim();
  if (!isEvmAddress(payTo)) return json(503, { error: "x402 payments are not configured on this server" });

  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const key = await verifyApiKey(bearer);
  if (!key) return json(401, { error: "Unauthorized: send your API key as 'Authorization: Bearer <key>'" }, { "WWW-Authenticate": "Bearer" });
  const rl = await rateLimit(`x402:${key.keyId}`, RATE_LIMIT, RATE_WINDOW_SEC);
  if (!rl.ok) return json(429, { error: "rate_limited" }, { "Retry-After": String(rl.retryAfter) });

  const data = await getJobForViewer(jobId, { id: key.customerId, email: key.email, isOperator: false });
  if (!data) return json(404, { error: "Job not found" });
  const { job } = data;
  if (job.environment !== "test") {
    return json(403, { error: "x402 is testnet-only (Base Sepolia) and this job is a live job. Pay with the Stripe checkoutUrl from accept_quote." });
  }
  const quote = data.quotes.at(-1);
  if (!quote) return json(409, { error: "Job has no quote yet", state: job.state });
  if (quote.pricingMode === "per_finding") {
    return json(409, { error: "x402 supports fixed pricing only. Call accept_quote with pricingMode 'fixed' first, or pay per_finding via Stripe.", pricingMode: quote.pricingMode });
  }

  const existing = await findX402PaymentForQuote(jobId, quote.version);
  if (existing) return json(200, alreadyPaidBody(jobId, existing));
  const otherPaid = data.payments.find((p) => p.quoteVersion === quote.version && PAID_STATUSES.includes(p.status) && !isX402SessionKey(p.stripeCheckoutSessionId));
  if (otherPaid) return json(409, { error: "This quote is already paid", state: job.state });
  if (!PAYABLE_STATES.includes(job.state)) return json(409, { error: "Job is not waiting for payment", state: job.state });

  const origin = (process.env.APP_URL ?? new URL(req.url).origin).replace(/\/$/, "");
  const args: X402QuoteArgs = {
    priceCents: quote.priceCents, payTo,
    resourceUrl: `${origin}${x402PayPath(jobId)}`,
    description: `Standard Evals ${quote.package.replace(/_/g, " ")} eval, job ${jobId}, quote v${quote.version} (${(quote.priceCents / 100).toFixed(2)} USDC, Base Sepolia testnet)`,
  };
  const header = readPaymentHeader(req);
  if (!header) return toResponse(paymentRequired(args));

  const payload = decodePayload(header);
  if (!payload) return json(400, { error: "Malformed PAYMENT-SIGNATURE header (expected base64 x402 v2 payment payload)" });

  // One settle per job+quote at a time (no header hash): concurrent different signatures cannot both charge.
  // Only successful (200) outcomes are stored; 402/5xx release the key so a corrected payment can be retried.
  const scope = `${key.customerId}:x402.pay:${jobId}:${quote.version}`;
  try {
    const out = await withIdempotency(scope, async () => {
      const res = await settleAndResume(jobId, job.state, quote, args, payload, deps);
      if (res.status !== 200) throw new NonFinalResponse(res);
      return res;
    });
    return toResponse(out, out.replayed);
  } catch (err) {
    if (err instanceof NonFinalResponse) return toResponse(err.response);
    if (err instanceof SettledUnrecordedError) return json(502, { error: err.message });
    if (err instanceof IdempotencyInProgressError) return json(409, { error: "This payment is still being processed; retry shortly" }, { "Retry-After": "5" });
    if (err instanceof TransientError) return json(err.status, { error: err.message }, { "Retry-After": "10" });
    console.error("x402 pay failed", jobId, err instanceof Error ? err.message : err);
    return json(500, { error: "Internal error" });
  }
}

type QuoteRow = typeof schema.quotes.$inferSelect;

async function settleAndResume(
  jobId: string, state: string, quote: QuoteRow, args: X402QuoteArgs, payload: PaymentPayload, deps: X402PayDeps,
): Promise<StoredResponse> {
  const requirements = buildRequirements(args);
  const mismatch = payloadMismatch(payload, requirements, args.resourceUrl);
  if (mismatch) return paymentRequired(args, mismatch);

  // Verify first: nothing about the job (quote acceptance) changes for a payment that cannot succeed.
  const facilitator = deps.facilitator();
  let verify;
  try {
    verify = await facilitator.verify(payload, requirements);
  } catch (err) {
    if (err instanceof VerifyError) return paymentRequired(args, `payment verification failed: ${err.invalidReason ?? err.message}`);
    throw new TransientError(`Facilitator verify unavailable: ${err instanceof Error ? err.message : "unknown"}`);
  }
  if (!verify.isValid) return paymentRequired(args, `payment verification failed: ${verify.invalidReason ?? "invalid"}`);

  // Accept the quote before taking money: the workflow needs quote_accepted before it waits for payment.
  if (state === "quoted") {
    await db().update(schema.quotes).set({ acceptedAt: sql`coalesce(${schema.quotes.acceptedAt}, now())` }).where(eq(schema.quotes.id, quote.id));
    try {
      await sendJobEvent(jobId, { type: "quote_accepted", quoteVersion: quote.version });
    } catch (err) {
      throw new TransientError(`Could not accept the quote (${err instanceof Error ? err.message : "unknown"}); nothing was charged`, 503);
    }
  }

  const auth = (payload.payload as { authorization?: { from?: string; nonce?: string } } | undefined)?.authorization;
  const payer = auth?.from ?? verify.payer ?? "unknown";
  const nonce = auth?.nonce ?? "unknown";
  let settle: SettleResponse;
  try {
    settle = await facilitator.settle(payload, requirements);
  } catch (err) {
    if (err instanceof SettleError) return paymentRequired(args, `payment settlement failed: ${err.errorReason ?? err.message}`);
    // Indeterminate: the facilitator may still have settled. Tell operators who to look for.
    console.error("x402 settle indeterminate", { jobId, payer, nonce, amountAtomic: requirements.amount, error: err instanceof Error ? err.message : String(err) });
    await alertOperators({
      kind: "x402_settle_indeterminate", jobId, severity: "critical", title: "x402 settle result unknown",
      detail: `Facilitator settle call failed after verify; funds may have moved. payer ${payer}, nonce ${nonce}, amount ${requirements.amount} atomic USDC.`,
    });
    throw new TransientError(`Facilitator settle unavailable: ${err instanceof Error ? err.message : "unknown"}`);
  }
  if (!settle.success) return paymentRequired(args, `payment settlement failed: ${settle.errorReason ?? "unknown"}`);

  // From here money has moved. Any failure must be surfaced loudly, never released silently.
  let values: ReturnType<typeof settlementValues>;
  let payment: Awaited<ReturnType<typeof recordX402Payment>>["payment"];
  let inserted: boolean;
  try {
    values = settlementValues(settle, requirements);
    ({ payment, inserted } = await recordX402Payment({ jobId, quoteVersion: quote.version, ...values }));
  } catch (err) {
    const txHash = settle.transaction ?? "unknown";
    console.error("x402 settled but not recorded", { jobId, txHash, payer: settle.payer ?? payer, amountAtomic: settle.amount ?? requirements.amount, error: err instanceof Error ? err.message : String(err) });
    await alertOperators({
      kind: "x402_settle_unrecorded", jobId, severity: "critical", title: "x402 payment settled but not recorded",
      detail: `tx ${txHash}, payer ${settle.payer ?? payer}, amount ${settle.amount ?? requirements.amount} atomic USDC. Record it or refund manually.`,
    });
    throw new SettledUnrecordedError("Your payment may have settled on-chain but we could not record it. Support has been notified; do not pay again.");
  }
  // Stop the Stripe checkout for this quote so the customer cannot also pay there (best effort).
  try { await expireOpenCheckout(jobId); } catch (err) { console.warn("x402: could not expire open checkout", jobId, err instanceof Error ? err.message : err); }
  let outcome: string = "already_resumed";
  if (!payment.workflowResumedAt) {
    try {
      outcome = await resumeJobForPayment(payment);
    } catch (err) {
      // Recorded but not yet delivered to the workflow: the reconcile cron retries (workflow_resumed_at stays null).
      console.error("x402 resume failed; reconcile will retry", payment.id, err instanceof Error ? err.message : err);
      outcome = "pending";
    }
  }
  return {
    status: 200,
    body: {
      ok: outcome !== "needs_review", jobId, paymentId: payment.id, inserted, outcome,
      txHash: values.txHash, network: X402_NETWORK, payer: values.payer, amountAtomic: values.amountAtomic,
      amountCents: values.amountCents, currency: "usdc", explorerUrl: explorerTxUrl(values.txHash),
      settlement: settle,
      note: outcome === "needs_review"
        ? "Payment settled but could not start work (job finished, quote changed or amount mismatch). It is flagged for a manual refund."
        : "Paid. Poll get_job until the job is delivered.",
    },
  };
}

function alreadyPaidBody(jobId: string, p: { id: string; stripeCheckoutSessionId: string; status: string; workflowResumedAt: Date | null }) {
  const txHash = p.stripeCheckoutSessionId.split(":").at(-1) ?? "";
  return {
    ok: p.status === "paid", jobId, paymentId: p.id, alreadyPaid: true, status: p.status, txHash, network: X402_NETWORK,
    explorerUrl: explorerTxUrl(txHash), resumed: !!p.workflowResumedAt,
    note: "This quote is already paid with x402; nothing was charged again. Poll get_job.",
  };
}

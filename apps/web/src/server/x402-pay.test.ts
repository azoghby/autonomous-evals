import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { SettleError } from "@x402/core/types";
import { buildRequirements, type PaymentPayload } from "@ae/core/payments/x402";

const JOB = "11111111-1111-4111-8111-111111111111";
const FOREIGN_JOB = "22222222-2222-4222-8222-222222222222";
const PAY_TO = "0xa6ADbA59D08B0e6688738e94c17a770E9B090891";
const TX = `0x${"cd".repeat(32)}`;
const PAYER = "0x9999999999999999999999999999999999999999";

type Row = { id: string; jobId: string; quoteVersion: number; stripeCheckoutSessionId: string; status: string; amountCents: number; currency: string; workflowResumedAt: Date | null };

let job: { id: string; customerId: string; state: string; environment: string };
let quote: { id: string; version: number; package: string; priceCents: number; pricingMode: string; capCents: number | null };
let payments: Row[];
const idem = new Map<string, { status: number; body: unknown } | null>();

vi.mock("./api-keys", () => ({
  verifyApiKey: vi.fn(async (bearer?: string) => (bearer === "ae_test_A" ? { keyId: "k1", customerId: "A", email: "a@x.test" } : bearer === "ae_test_B" ? { keyId: "k2", customerId: "B", email: "b@x.test" } : null)),
}));
vi.mock("./rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true, retryAfter: 0 })) }));
vi.mock("./queries", () => ({
  getJobForViewer: vi.fn(async (jobId: string, viewer: { id: string }) => {
    if (jobId !== job.id || viewer.id !== job.customerId) return null;
    return { job: { ...job }, quotes: [quote], payments: payments.filter((p) => p.jobId === jobId) };
  }),
}));
vi.mock("./idempotency", () => {
  class IdempotencyInProgressError extends Error {}
  return {
    IdempotencyInProgressError,
    withIdempotency: async (key: string, fn: () => Promise<{ status: number; body: unknown }>) => {
      if (idem.has(key)) {
        const stored = idem.get(key);
        if (!stored) throw new IdempotencyInProgressError("in progress");
        return { ...stored, replayed: true };
      }
      idem.set(key, null);
      try {
        const res = await fn();
        idem.set(key, res);
        return { ...res, replayed: false };
      } catch (err) {
        idem.delete(key);
        throw err;
      }
    },
  };
});
vi.mock("@ae/core/db/client", () => ({
  db: () => ({ update: () => ({ set: () => ({ where: async () => undefined }) }) }),
  schema: new Proxy({}, { get: () => new Proxy({}, { get: (_t, c) => String(c) }) }),
}));
/** In-memory payments with the real uniqueness rule: one row per tx-derived key. */
vi.mock("@ae/core/payments/x402-store", () => ({
  recordX402Payment: vi.fn(async (a: { jobId: string; quoteVersion: number; network: string; txHash: string; amountCents: number }) => {
    const key = `x402:${a.network}:${a.txHash}`;
    const found = payments.find((p) => p.stripeCheckoutSessionId === key);
    if (found) return { payment: found, inserted: false };
    const row: Row = { id: `pay${payments.length + 1}`, jobId: a.jobId, quoteVersion: a.quoteVersion, stripeCheckoutSessionId: key, status: "paid", amountCents: a.amountCents, currency: "usdc", workflowResumedAt: null };
    payments.push(row);
    return { payment: row, inserted: true };
  }),
  findX402PaymentForQuote: vi.fn(async (jobId: string, v: number) => payments.find((p) => p.jobId === jobId && p.quoteVersion === v && p.stripeCheckoutSessionId.startsWith("x402:")) ?? null),
}));
const { sendJobEvent, resumeJobForPayment } = vi.hoisted(() => ({
  sendJobEvent: vi.fn(async (..._a: unknown[]) => undefined),
  resumeJobForPayment: vi.fn(async (p: { workflowResumedAt: Date | null }) => { p.workflowResumedAt = new Date(); return "resumed"; }),
}));
vi.mock("@/workflows/events", () => ({ sendJobEvent }));
vi.mock("@/workflows/resume", () => ({ resumeJobForPayment }));

import { handleX402Pay } from "./x402-pay";

const facilitator = { verify: vi.fn(), settle: vi.fn(), getSupported: vi.fn() };
const deps = { facilitator: () => facilitator };
const url = `https://ae.test/api/x402/jobs/${JOB}/pay`;

const requirements = () => buildRequirements({ priceCents: quote.priceCents, payTo: PAY_TO, resourceUrl: url, description: "d" });
function signedHeader(over: Record<string, unknown> = {}, nonce = "0x01") {
  const payload = {
    x402Version: 2, resource: { url },
    accepted: { ...requirements(), ...over },
    payload: { signature: "0xsig", authorization: { from: PAYER, to: PAY_TO, value: String(over.amount ?? requirements().amount), validAfter: "0", validBefore: "9999999999", nonce } },
  } as unknown as PaymentPayload;
  return encodePaymentSignatureHeader(payload);
}
const post = (headers: Record<string, string> = {}, jobId = JOB, key = "ae_test_A") =>
  handleX402Pay(new Request(url, { method: "POST", headers: { authorization: `Bearer ${key}`, ...headers } }), jobId, deps);

beforeEach(() => {
  vi.clearAllMocks();
  idem.clear();
  process.env.X402_PAY_TO = PAY_TO;
  process.env.APP_URL = "https://ae.test";
  job = { id: JOB, customerId: "A", state: "awaiting_payment", environment: "test" };
  quote = { id: "q1", version: 2, package: "text_eval", priceCents: 500, pricingMode: "fixed", capCents: null };
  payments = [];
  facilitator.verify.mockResolvedValue({ isValid: true, payer: PAYER });
  facilitator.settle.mockResolvedValue({ success: true, transaction: TX, network: "eip155:84532", payer: PAYER });
});

describe("402 payment requirements", () => {
  it("returns x402 v2 requirements in the PAYMENT-REQUIRED header and body without a payment header", async () => {
    const res = await post();
    expect(res.status).toBe(402);
    const body = await res.json();
    const header = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    expect(header).toEqual(body);
    expect(body).toMatchObject({
      x402Version: 2,
      resource: { url, mimeType: "application/json" },
      accepts: [{ scheme: "exact", network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", amount: "5000000", payTo: PAY_TO, extra: { name: "USDC", version: "2" } }],
    });
    expect(body.resource.description).toMatch(/5\.00 USDC/);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });
  it("is disabled (503) when X402_PAY_TO is not configured", async () => {
    delete process.env.X402_PAY_TO;
    expect((await post()).status).toBe(503);
  });
  it("rejects per_finding quotes with a clear error", async () => {
    quote.pricingMode = "per_finding"; quote.capCents = 3000;
    const res = await post();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/fixed pricing only/);
  });
  it("refuses live jobs (testnet only)", async () => {
    job.environment = "live";
    expect((await post()).status).toBe(403);
  });
});

describe("authz", () => {
  it("401 without or with an invalid API key", async () => {
    expect((await handleX402Pay(new Request(url, { method: "POST" }), JOB, deps)).status).toBe(401);
    expect((await post({}, JOB, "ae_test_nope")).status).toBe(401);
  });
  it("404 for another customer's job, indistinguishable from a missing one, and nothing is settled", async () => {
    const res = await post({ "PAYMENT-SIGNATURE": signedHeader() }, JOB, "ae_test_B");
    expect(res.status).toBe(404);
    expect((await post({}, FOREIGN_JOB)).status).toBe(404);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});

describe("paying", () => {
  it("verifies, settles, records (usdc, tx hash) and resumes the job", async () => {
    const res = await post({ "PAYMENT-SIGNATURE": signedHeader() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, outcome: "resumed", txHash: TX, network: "eip155:84532", payer: PAYER, amountCents: 500, currency: "usdc" });
    expect(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!).transaction).toBe(TX);
    expect(facilitator.verify).toHaveBeenCalledWith(expect.objectContaining({ x402Version: 2 }), expect.objectContaining({ amount: "5000000", payTo: PAY_TO }));
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ quoteVersion: 2, amountCents: 500, currency: "usdc", stripeCheckoutSessionId: `x402:eip155:84532:${TX}` });
    expect(resumeJobForPayment).toHaveBeenCalledTimes(1);
    expect(sendJobEvent).not.toHaveBeenCalled();
  });
  it("accepts the legacy X-PAYMENT header name", async () => {
    expect((await post({ "X-PAYMENT": signedHeader() })).status).toBe(200);
  });
  it("accepts the quote first when the job is still quoted", async () => {
    job.state = "quoted";
    expect((await post({ "PAYMENT-SIGNATURE": signedHeader() })).status).toBe(200);
    expect(sendJobEvent).toHaveBeenCalledWith(JOB, { type: "quote_accepted", quoteVersion: 2 });
  });
  it("rejects an amount mismatch with 402 before verify/settle, so nothing is charged", async () => {
    for (const amount of ["4999999", "5000001", "1"]) {
      const res = await post({ "PAYMENT-SIGNATURE": signedHeader({ amount }, `0x${amount}`) });
      expect(res.status).toBe(402);
      expect((await res.json()).error).toMatch(/amount mismatch/);
    }
    const wrongPayTo = await post({ "PAYMENT-SIGNATURE": signedHeader({ payTo: PAYER }, "0x77") });
    expect((await wrongPayTo.json()).error).toMatch(/payTo/);
    expect(facilitator.verify).not.toHaveBeenCalled();
    expect(facilitator.settle).not.toHaveBeenCalled();
    expect(payments).toHaveLength(0);
  });
  it("returns 402 when the facilitator says the payment is invalid", async () => {
    facilitator.verify.mockResolvedValue({ isValid: false, invalidReason: "insufficient_funds" });
    const res = await post({ "PAYMENT-SIGNATURE": signedHeader() });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toMatch(/insufficient_funds/);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
  it("maps a facilitator SettleError to 402 and an outage to a retryable 502", async () => {
    facilitator.settle.mockRejectedValueOnce(new SettleError(400, { success: false, errorReason: "invalid_transaction_state", transaction: "", network: "eip155:84532" }));
    expect((await post({ "PAYMENT-SIGNATURE": signedHeader({}, "0xa1") })).status).toBe(402);
    facilitator.settle.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect((await post({ "PAYMENT-SIGNATURE": signedHeader({}, "0xa2") })).status).toBe(502);
    // The transient failure released the idempotency key: the same header can be retried.
    expect((await post({ "PAYMENT-SIGNATURE": signedHeader({}, "0xa2") })).status).toBe(200);
  });
  it("400 on a malformed payment header", async () => {
    expect((await post({ "PAYMENT-SIGNATURE": "not-base64-json" })).status).toBe(400);
  });
});

describe("idempotency", () => {
  it("double-submitting the same signed payment settles once and replays the result", async () => {
    const header = signedHeader();
    const first = await post({ "PAYMENT-SIGNATURE": header });
    const second = await post({ "PAYMENT-SIGNATURE": header });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const [a, b] = [await first.json(), await second.json()];
    expect(b.paymentId).toBe(a.paymentId);
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
    expect(payments).toHaveLength(1);
    expect(resumeJobForPayment).toHaveBeenCalledTimes(1);
  });
  it("a different signature for an already paid quote is not charged again", async () => {
    await post({ "PAYMENT-SIGNATURE": signedHeader({}, "0x01") });
    const again = await post({ "PAYMENT-SIGNATURE": signedHeader({}, "0x02") });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ alreadyPaid: true, txHash: TX });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });
  it("the same tx hash reported twice records one payment row", async () => {
    await post({ "PAYMENT-SIGNATURE": signedHeader({}, "0x01") });
    payments[0].quoteVersion = 1; // force past the already-paid shortcut
    await post({ "PAYMENT-SIGNATURE": signedHeader({}, "0x02") });
    expect(payments).toHaveLength(1);
  });
  it("409 when the quote was already paid through Stripe", async () => {
    payments = [{ id: "s1", jobId: JOB, quoteVersion: 2, stripeCheckoutSessionId: "cs_test_1", status: "paid", amountCents: 500, currency: "usd", workflowResumedAt: new Date() }];
    expect((await post({ "PAYMENT-SIGNATURE": signedHeader() })).status).toBe(409);
    expect(facilitator.settle).not.toHaveBeenCalled();
  });
});

describe("cancelled jobs", () => {
  it("refuses to charge once the job is cancelled", async () => {
    job.state = "cancelled";
    const res = await post({ "PAYMENT-SIGNATURE": signedHeader() });
    expect(res.status).toBe(409);
    expect(facilitator.verify).not.toHaveBeenCalled();
  });
  it("a payment that settles after a concurrent cancel is recorded and flagged for refund, not resumed", async () => {
    resumeJobForPayment.mockImplementationOnce(async (p: Row) => { p.status = "needs_refund"; p.workflowResumedAt = new Date(); return "needs_review"; });
    const res = await post({ "PAYMENT-SIGNATURE": signedHeader() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: "needs_review" });
    expect(body.note).toMatch(/refund/);
    expect(payments[0].status).toBe("needs_refund");
  });
  it("keeps the payment for the reconcile cron when resuming throws", async () => {
    resumeJobForPayment.mockRejectedValueOnce(new Error("queue down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await post({ "PAYMENT-SIGNATURE": signedHeader() });
    expect(await res.json()).toMatchObject({ outcome: "pending" });
    expect(payments[0].workflowResumedAt).toBeNull();
    err.mockRestore();
  });
});

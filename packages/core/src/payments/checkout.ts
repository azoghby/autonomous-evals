import type Stripe from "stripe";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../db/client";
import type { JobEvent } from "../contracts/index";
import { MONITORING_PRICE_CENTS_MONTHLY, paymentMatchesQuote, perFindingCaptureCents, type PricingMode } from "../contracts/index";
import { getStripeMode, stripe } from "./stripe";

/** Delivers an event to a job's workflow. Injected so core never depends on the web app. */
export type SendJobEvent = (jobId: string, event: JobEvent) => Promise<void>;
export type PaymentRow = typeof schema.payments.$inferSelect;

export interface CheckoutArgs {
  jobId: string;
  quoteVersion: number;
  priceCents: number;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  productName?: string;
  /** 'per_finding': priceCents is the authorization cap, held with manual capture and charged at delivery. */
  pricingMode?: PricingMode;
  /** Only set after the previous session for this quote expired (Stripe replays cached responses per idempotency key). */
  retryAfterSessionId?: string;
}

export const checkoutIdempotencyKey = (jobId: string, quoteVersion: number, retryAfterSessionId?: string) =>
  `checkout:${jobId}:${quoteVersion}${retryAfterSessionId ? `:after:${retryAfterSessionId}` : ""}`;

export async function createCheckoutForQuote(a: CheckoutArgs): Promise<{ sessionId: string; url: string }> {
  if (!Number.isInteger(a.priceCents) || a.priceCents <= 0) throw new Error("priceCents must be a positive integer");
  const perFinding = a.pricingMode === "per_finding";
  const metadata = {
    job_id: a.jobId, quote_version: String(a.quoteVersion), environment: getStripeMode(),
    pricing_mode: perFinding ? "per_finding" : "fixed",
  };
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    customer_email: a.customerEmail,
    client_reference_id: a.jobId,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd", unit_amount: a.priceCents,
        product_data: { name: a.productName ?? "Autonomous Evals report" },
      },
    }],
    metadata,
    payment_intent_data: perFinding ? { capture_method: "manual", metadata } : { metadata },
    success_url: a.successUrl,
    cancel_url: a.cancelUrl,
  }, { idempotencyKey: `${checkoutIdempotencyKey(a.jobId, a.quoteVersion, a.retryAfterSessionId)}${perFinding ? ":pf" : ""}` });
  if (!session.url) throw new Error("Stripe returned a checkout session without a URL");
  return { sessionId: session.id, url: session.url };
}

/** $49/month monitoring subscription for a delivered job. */
export async function createMonitoringCheckout(
  jobId: string,
  opts: { customerEmail: string; successUrl: string; cancelUrl: string },
): Promise<{ sessionId: string; url: string }> {
  const metadata = { job_id: jobId, quote_version: "0", kind: "monitoring", environment: getStripeMode() };
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer_email: opts.customerEmail,
    client_reference_id: jobId,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd", unit_amount: MONITORING_PRICE_CENTS_MONTHLY, recurring: { interval: "month" },
        product_data: { name: "Autonomous Evals monitoring" },
      },
    }],
    metadata,
    subscription_data: { metadata },
    success_url: opts.successUrl,
    cancel_url: opts.cancelUrl,
  }, { idempotencyKey: `monitoring:${jobId}:${new Date().toISOString().slice(0, 10)}` });
  if (!session.url) throw new Error("Stripe returned a checkout session without a URL");
  return { sessionId: session.id, url: session.url };
}

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : v?.id ?? null);

/**
 * A per_finding Checkout completes with payment_status 'unpaid' while its PaymentIntent sits in
 * 'requires_capture'. That hold counts as payment confirmed for workflow purposes.
 */
export async function isManualCaptureAuthorized(session: Stripe.Checkout.Session): Promise<boolean> {
  if (session.mode !== "payment" || session.metadata?.pricing_mode !== "per_finding") return false;
  if (session.status !== "complete" || session.payment_status === "paid") return false;
  const piId = idOf(session.payment_intent);
  if (!piId) return false;
  const pi = await stripe().paymentIntents.retrieve(piId);
  return pi.status === "requires_capture";
}

/**
 * Persists a paid (or manual-capture authorized) session as a payment row. Idempotent: the unique session id (and event id) make a
 * second call a no-op that returns the existing row with inserted=false.
 */
export async function recordPaymentFromSession(
  session: Stripe.Checkout.Session, eventId: string | null,
): Promise<{ payment: PaymentRow; inserted: boolean }> {
  const authorized = await isManualCaptureAuthorized(session);
  if (session.payment_status !== "paid" && !authorized) throw new Error(`Session ${session.id} is not paid (${session.payment_status})`);
  const jobId = session.metadata?.job_id;
  const quoteVersion = Number(session.metadata?.quote_version);
  if (!jobId || !Number.isInteger(quoteVersion) || quoteVersion < 0) {
    throw new Error(`Session ${session.id} is missing job_id/quote_version metadata`);
  }
  const rows = await db().insert(schema.payments).values({
    jobId, quoteVersion,
    stripeEventId: eventId,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: idOf(session.payment_intent),
    amountCents: session.amount_total ?? 0,
    currency: session.currency ?? "usd",
    environment: session.livemode ? "live" : "test",
    kind: session.mode === "subscription" ? "subscription" : "one_time",
    status: authorized ? "authorized" : "paid",
  }).onConflictDoNothing().returning();
  if (rows[0]) return { payment: rows[0], inserted: true };
  const [existing] = await db().select().from(schema.payments)
    .where(eq(schema.payments.stripeCheckoutSessionId, session.id)).limit(1);
  if (!existing) throw new Error(`Payment for session ${session.id} conflicted but could not be found`);
  return { payment: existing, inserted: false };
}

export type ResumeOutcome = "resumed" | "needs_review" | "not_applicable";

const TERMINAL_JOB_STATES = ["cancelled", "failed", "delivered"];

/**
 * Expires the open Checkout session of the job's latest quote so a cancelled job cannot still be paid.
 * Best effort: a missing Stripe key or an already expired/completed session is logged, never thrown
 * (a payment that still lands is caught by the late-payment handler in confirmAndResume).
 */
export async function expireOpenCheckout(jobId: string): Promise<"expired" | "skipped"> {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn(`expireOpenCheckout: STRIPE_SECRET_KEY not set, skipping session expiry for job ${jobId}`);
    return "skipped";
  }
  const [quote] = await db().select({ sessionId: schema.quotes.stripeCheckoutSessionId }).from(schema.quotes)
    .where(eq(schema.quotes.jobId, jobId)).orderBy(desc(schema.quotes.version)).limit(1);
  if (!quote?.sessionId) return "skipped";
  try {
    await stripe().checkout.sessions.expire(quote.sessionId);
    return "expired";
  } catch (err) {
    // Already expired / already complete sessions reject expire(); nothing more to do here.
    console.warn(`expireOpenCheckout: could not expire ${quote.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    return "skipped";
  }
}

type StrandedReason = "job_finished" | "stale_quote" | "workflow_gone" | "amount_mismatch";

const STRANDED_NOTE: Record<StrandedReason, string> = {
  job_finished: "payment arrived after the job was cancelled/failed/delivered",
  stale_quote: "payment is for a superseded quote version",
  workflow_gone: "payment arrived but the job workflow is no longer waiting",
  amount_mismatch: "paid amount/currency does not match the quote; work was NOT started",
};

/**
 * A payment that must not start (or resume) work. per_finding holds are released immediately; captured
 * fixed payments are marked needs_refund with a refund intervention (refunds stay manual). Always stamps
 * workflow_resumed_at so the reconcile cron stops retrying. Idempotent via the conditional status update.
 */
async function handleStrandedPayment(payment: PaymentRow, reason: StrandedReason): Promise<void> {
  const perFinding = payment.status === "authorized";
  if (perFinding && reason !== "amount_mismatch" && payment.stripePaymentIntentId) {
    await stripe().paymentIntents.cancel(payment.stripePaymentIntentId, undefined, { idempotencyKey: `release-late:${payment.id}` });
  }
  const releasing = perFinding && reason !== "amount_mismatch";
  const claimed = await db().update(schema.payments)
    .set({ status: releasing ? "released" : payment.status === "paid" ? "needs_refund" : payment.status, ...(releasing ? { capturedAmountCents: 0 } : {}) })
    .where(and(eq(schema.payments.id, payment.id), inArray(schema.payments.status, ["paid", "authorized"])))
    .returning({ id: schema.payments.id });
  if (claimed.length > 0 && !releasing) {
    const amount = `${(payment.amountCents / 100).toFixed(2)} ${payment.currency.toUpperCase()}`;
    const kind = payment.status === "paid" ? "refund" : "other";
    await db().insert(schema.interventions).values({
      jobId: payment.jobId, operatorEmail: "system", kind,
      note: `${kind === "refund" ? "Refund needed" : "Review needed"}: ${amount} (payment ${payment.id}, PaymentIntent ${payment.stripePaymentIntentId ?? "n/a"}, quote v${payment.quoteVersion}): ${STRANDED_NOTE[reason]}.`,
    });
  } else if (claimed.length > 0 && releasing) {
    await db().insert(schema.interventions).values({
      jobId: payment.jobId, operatorEmail: "system", kind: "other",
      note: `Released late authorization of ${(payment.amountCents / 100).toFixed(2)} ${payment.currency.toUpperCase()} (payment ${payment.id}): ${STRANDED_NOTE[reason]}.`,
    });
  }
  if (reason === "workflow_gone") await flagPaymentReview(payment);
  await db().update(schema.payments).set({ workflowResumedAt: new Date() })
    .where(and(eq(schema.payments.id, payment.id), isNull(schema.payments.workflowResumedAt)));
}

/** Why this payment must not resume the workflow, or null if it may. */
async function strandedReasonFor(payment: PaymentRow): Promise<StrandedReason | null> {
  const [job] = await db().select({ state: schema.jobs.state }).from(schema.jobs).where(eq(schema.jobs.id, payment.jobId)).limit(1);
  if (job && TERMINAL_JOB_STATES.includes(job.state)) return "job_finished";
  const [latest] = await db().select().from(schema.quotes).where(eq(schema.quotes.jobId, payment.jobId))
    .orderBy(desc(schema.quotes.version)).limit(1);
  if (latest && latest.version !== payment.quoteVersion) return "stale_quote";
  if (latest && !paymentMatchesQuote(payment, latest)) return "amount_mismatch";
  return null;
}

/**
 * Sends payment_confirmed to the job's workflow, then stamps workflow_resumed_at. If the send throws
 * the stamp stays null so the webhook retry / reconcile cron tries again. Payments that cannot start
 * work (finished job, stale quote, wrong amount, workflow gone) are handled and stamped instead.
 */
export async function confirmAndResume(payment: PaymentRow, send: SendJobEvent): Promise<ResumeOutcome> {
  if (payment.kind !== "one_time") {
    await db().update(schema.payments).set({ workflowResumedAt: new Date() }).where(eq(schema.payments.id, payment.id));
    return "not_applicable";
  }
  const reason = await strandedReasonFor(payment);
  if (reason) {
    await handleStrandedPayment(payment, reason);
    return "needs_review";
  }
  try {
    await send(payment.jobId, { type: "payment_confirmed", paymentId: payment.id, quoteVersion: payment.quoteVersion });
  } catch (err) {
    if (err instanceof Error && err.name === "HookNotFoundError") {
      await handleStrandedPayment(payment, "workflow_gone");
      return "needs_review";
    }
    throw err;
  }
  await db().update(schema.payments).set({ workflowResumedAt: new Date() })
    .where(and(eq(schema.payments.id, payment.id), isNull(schema.payments.workflowResumedAt)));
  return "resumed";
}

/** Moves a job still waiting on payment to payment_review so an operator sees it. No-op for any other state. */
async function flagPaymentReview(payment: PaymentRow): Promise<void> {
  const moved = await db().update(schema.jobs).set({ state: "payment_review", updatedAt: new Date() })
    .where(and(eq(schema.jobs.id, payment.jobId), eq(schema.jobs.state, "awaiting_payment")))
    .returning({ id: schema.jobs.id });
  if (moved.length > 0) {
    await db().insert(schema.progressEvents).values({
      jobId: payment.jobId, milestone: "payment_review",
      message: "Payment received but the job workflow is no longer waiting. An operator will review.",
    });
  }
}

export interface ReconcileSummary { sessionsChecked: number; recorded: number; resumed: number; needsReview: number; errors: string[] }

/** Safety net for missed webhooks: record any paid sessions from the last 24h, then resume every unresumed payment. */
export async function reconcile(send: SendJobEvent, now: Date = new Date()): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { sessionsChecked: 0, recorded: 0, resumed: 0, needsReview: 0, errors: [] };
  const since = Math.floor((now.getTime() - 24 * 3600_000) / 1000);
  const sessions = stripe().checkout.sessions.list({ created: { gte: since }, limit: 100 });
  for await (const s of sessions) {
    summary.sessionsChecked++;
    if (summary.sessionsChecked > 1000) break;
    if (!s.metadata?.job_id) continue;
    try {
      if (s.payment_status !== "paid" && !(await isManualCaptureAuthorized(s))) continue;
      const { inserted } = await recordPaymentFromSession(s, null);
      if (inserted) summary.recorded++;
    } catch (err) {
      summary.errors.push(`${s.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const pending = await db().select().from(schema.payments)
    .where(and(isNull(schema.payments.workflowResumedAt), gte(schema.payments.createdAt, new Date(now.getTime() - 7 * 86400_000))));
  for (const p of pending) {
    try {
      const outcome = await confirmAndResume(p, send);
      if (outcome === "resumed") summary.resumed++;
      else if (outcome === "needs_review") summary.needsReview++;
    } catch (err) {
      summary.errors.push(`payment ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return summary;
}

export interface SettleResult {
  outcome: "captured" | "released" | "not_applicable" | "already_settled";
  confirmedCount: number;
  amountCents: number;
}

/**
 * Settles a per_finding authorization at delivery: captures min(3 USD * confirmed, cap) or, with no
 * confirmed findings, cancels the PaymentIntent. Idempotent: a settled row is returned as-is and
 * Stripe's idempotency key makes a retried capture/cancel safe.
 */
export async function settlePerFindingPayment(jobId: string, confirmedCount: number): Promise<SettleResult> {
  const [row] = await db().select({ payment: schema.payments, quote: schema.quotes })
    .from(schema.payments)
    .innerJoin(schema.quotes, and(eq(schema.quotes.jobId, schema.payments.jobId), eq(schema.quotes.version, schema.payments.quoteVersion)))
    .where(and(eq(schema.payments.jobId, jobId), eq(schema.payments.kind, "one_time"), inArray(schema.payments.status, ["authorized", "captured", "released"])))
    .orderBy(desc(schema.payments.createdAt)).limit(1);
  if (!row || row.quote.pricingMode !== "per_finding") return { outcome: "not_applicable", confirmedCount, amountCents: 0 };
  const { payment, quote } = row;
  if (payment.status !== "authorized") {
    return { outcome: "already_settled", confirmedCount, amountCents: payment.capturedAmountCents ?? 0 };
  }
  if (!payment.stripePaymentIntentId) throw new Error(`Payment ${payment.id} has no PaymentIntent to settle`);
  const cap = quote.capCents ?? payment.amountCents;
  const amount = Math.min(perFindingCaptureCents(confirmedCount, cap), payment.amountCents);
  if (amount > 0) {
    await stripe().paymentIntents.capture(payment.stripePaymentIntentId, { amount_to_capture: amount }, { idempotencyKey: `capture:${jobId}` });
    await db().update(schema.payments).set({ status: "captured", capturedAmountCents: amount }).where(eq(schema.payments.id, payment.id));
    return { outcome: "captured", confirmedCount, amountCents: amount };
  }
  await stripe().paymentIntents.cancel(payment.stripePaymentIntentId, undefined, { idempotencyKey: `release:${jobId}` });
  await db().update(schema.payments).set({ status: "released", capturedAmountCents: 0 }).where(eq(schema.payments.id, payment.id));
  return { outcome: "released", confirmedCount, amountCents: 0 };
}

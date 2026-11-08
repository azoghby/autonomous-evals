import "server-only";
import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { recordPaymentFromSession } from "@ae/core/payments/checkout";
import { isUuid, jsonError, requireOperator } from "@/server/http";
import { latestQuote } from "@/server/job-store";
import { sendJobEvent } from "@/workflows/events";
import { resumeJobForPayment } from "@/workflows/resume";

export const dynamic = "force-dynamic";

/**
 * DEV ONLY. Simulates "customer accepted the quote and paid" for a mock, test-environment job without Stripe,
 * going through the same recordPaymentFromSession + confirmAndResume path as the real webhook.
 * 404 unless NODE_ENV==='development' and DEV_SIMULATE_PAYMENTS=1; requires an operator session.
 * Idempotent: the fake session id is derived from the job id, so repeats record one payment and send one resume.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development" || process.env.DEV_SIMULATE_PAYMENTS !== "1") {
    return new Response("Not found", { status: 404 });
  }
  const op = await requireOperator();
  if (op.res) return op.res;
  const body = (await request.json().catch(() => null)) as { jobId?: unknown } | null;
  const jobId = typeof body?.jobId === "string" ? body.jobId : "";
  if (!isUuid(jobId)) return jsonError(400, "jobId (uuid) required");

  const [job] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) return jsonError(404, "Job not found");
  if (job.environment !== "test" || !job.isMock) return jsonError(403, "Only mock jobs in the test environment can be simulated");
  const quote = await latestQuote(jobId);
  if (!quote) return jsonError(409, "Job has no quote yet", { state: job.state });

  if (job.state === "quoted") {
    await db().update(schema.quotes).set({ acceptedAt: sql`coalesce(${schema.quotes.acceptedAt}, now())` }).where(eq(schema.quotes.id, quote.id));
    await sendJobEvent(jobId, { type: "quote_accepted", quoteVersion: quote.version });
  }

  const session = {
    id: `cs_test_sim_${jobId}`, object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid",
    livemode: false, currency: "usd", amount_total: quote.priceCents, payment_intent: null,
    metadata: { job_id: jobId, quote_version: String(quote.version), environment: "test", pricing_mode: "fixed" },
  } as unknown as Stripe.Checkout.Session;
  const { payment, inserted } = await recordPaymentFromSession(session, null);
  let outcome: string = "already_resumed";
  if (!payment.workflowResumedAt) outcome = await resumeJobForPayment(payment);
  return Response.json({ ok: true, paymentId: payment.id, inserted, outcome, jobState: job.state });
}

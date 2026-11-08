import type Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { stripe, webhookSecret, getStripeMode } from "@ae/core/payments/stripe";
import { isManualCaptureAuthorized, recordPaymentFromSession } from "@ae/core/payments/checkout";
import { recordPlanPurchase, syncSubscription } from "@ae/core/payments/plans-checkout";
import { alertOperators } from "@/server/operator-alerts";
import { resumeJobForPayment } from "../../../../workflows/resume";

export const dynamic = "force-dynamic";

const HANDLED = new Set([
  "checkout.session.completed", "checkout.session.async_payment_succeeded",
  "customer.subscription.updated", "customer.subscription.deleted",
]);

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return Response.json({ error: "Missing stripe-signature" }, { status: 400 });

  // Raw body is required for signature verification; never parse JSON first.
  const raw = await request.text();
  let client: ReturnType<typeof stripe>, secret: string;
  try {
    client = stripe();
    secret = webhookSecret();
  } catch (err) {
    // Our misconfiguration (missing key/secret, key/mode mismatch): 500 so Stripe retries once fixed.
    console.error("stripe webhook misconfigured:", err instanceof Error ? err.message : err);
    return Response.json({ error: "Webhook not configured" }, { status: 500 });
  }
  let event: Stripe.Event;
  try {
    event = client.webhooks.constructEvent(raw, signature, secret);
  } catch {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (!HANDLED.has(event.type)) return Response.json({ received: true, ignored: event.type });
  if (event.livemode !== (getStripeMode() === "live")) return Response.json({ received: true, ignored: "environment_mismatch" });

  if (event.type.startsWith("customer.subscription.")) {
    try {
      const customerId = await syncSubscription(event.data.object as Stripe.Subscription);
      return Response.json({ received: true, synced: customerId !== null });
    } catch (err) {
      console.error("stripe webhook subscription sync failed", event.id, err instanceof Error ? err.message : err);
      return Response.json({ error: "Processing failed" }, { status: 500 });
    }
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const planKind = session.metadata?.kind;
  if (planKind === "plan" || planKind === "agent_audit") return handlePlanSession(session, event.id);
  if (!session.metadata?.job_id) return Response.json({ received: true, ignored: "no_job_metadata" });
  try {
    // Manual-capture (per_finding) sessions complete as 'unpaid' with the PaymentIntent in requires_capture.
    if (session.payment_status !== "paid" && !(await isManualCaptureAuthorized(session))) {
      return Response.json({ received: true, ignored: "not_paid_yet" });
    }
  } catch (err) {
    console.error("stripe webhook authorization check failed", event.id, err instanceof Error ? err.message : err);
    return Response.json({ error: "Processing failed" }, { status: 500 });
  }

  try {
    // Persist the resumable payment signal BEFORE acknowledging.
    const { payment, inserted } = await recordPaymentFromSession(session, event.id);
    if (session.mode === "subscription") {
      await activateMonitoring(session);
    }
    if (!payment.workflowResumedAt) {
      await resumeJobForPayment(payment); // throws -> 500 -> Stripe retries; row stays unresumed for cron
    }
    return Response.json({ received: true, duplicate: !inserted });
  } catch (err) {
    console.error("stripe webhook processing failed", event.id, err instanceof Error ? err.message : err);
    return Response.json({ error: "Processing failed" }, { status: 500 });
  }
}

async function activateMonitoring(session: Stripe.Checkout.Session): Promise<void> {
  const jobId = session.metadata!.job_id!;
  const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id ?? null;
  const [existing] = await db().select({ id: schema.monitoringSubscriptions.id }).from(schema.monitoringSubscriptions)
    .where(and(eq(schema.monitoringSubscriptions.jobId, jobId), eq(schema.monitoringSubscriptions.stripeSubscriptionId, subId ?? ""))).limit(1);
  if (existing) return;
  const [job] = await db().select({ customerId: schema.jobs.customerId }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) return;
  await db().insert(schema.monitoringSubscriptions).values({
    jobId, customerId: job.customerId, stripeSubscriptionId: subId, status: "active", environment: session.livemode ? "live" : "test",
  });
}

async function handlePlanSession(session: Stripe.Checkout.Session, eventId: string): Promise<Response> {
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    return Response.json({ received: true, ignored: "not_paid_yet" });
  }
  try {
    const r = await recordPlanPurchase(session, eventId);
    if (r.inserted && r.kind === "agent_audit") {
      // Alerting never fails the webhook; the purchase is already persisted.
      await alertOperators({
        kind: "agent_audit_purchased", title: "Agent Audit purchased",
        detail: `Agent Audit purchased by ${r.email} \u2014 deliver within 72h`, severity: "warning",
      }).catch((err) => console.error("agent audit alert failed", err instanceof Error ? err.message : err));
    }
    return Response.json({ received: true, duplicate: !r.inserted });
  } catch (err) {
    console.error("stripe webhook plan processing failed", eventId, err instanceof Error ? err.message : err);
    return Response.json({ error: "Processing failed" }, { status: 500 });
  }
}

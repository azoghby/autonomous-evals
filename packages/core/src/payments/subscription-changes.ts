import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { lookupKeyFor, type BillingInterval, type SelfServePlanId } from "../pricing/plans";
import { getStripeMode, stripe } from "./stripe";

/** Monitoring subscriptions the nightly cron may run (and pay model costs for). Everything else is paused. */
export const RUNNABLE_MONITORING_STATUSES = ["active", "trialing"] as const;

/**
 * Mirrors a Stripe monitoring subscription's status onto monitoring_subscriptions (by stripe_subscription_id), so a
 * canceled / unpaid / past_due subscription stops being run at our cost. Returns the number of rows updated.
 */
export async function syncMonitoringSubscription(subscription: Stripe.Subscription): Promise<number> {
  const rows = await db().update(schema.monitoringSubscriptions)
    .set({ status: subscription.status })
    .where(eq(schema.monitoringSubscriptions.stripeSubscriptionId, subscription.id))
    .returning({ id: schema.monitoringSubscriptions.id });
  return rows.length;
}

export interface PlanChangeArgs {
  customerId: string;
  stripeSubscriptionId: string;
  plan: SelfServePlanId;
  interval: BillingInterval;
}

/**
 * Switches an existing plan subscription to another plan/interval in place (prorated), instead of creating a second
 * subscription that would keep billing alongside the first. Returns the updated subscription.
 */
export async function changePlanSubscription(
  a: PlanChangeArgs,
  resolvePrice: (lookupKey: string) => Promise<string>,
): Promise<Stripe.Subscription> {
  const client = stripe();
  const current = await client.subscriptions.retrieve(a.stripeSubscriptionId);
  const item = current.items?.data?.[0];
  if (!item) throw new Error(`Subscription ${a.stripeSubscriptionId} has no items`);
  const price = await resolvePrice(lookupKeyFor(a.plan, a.interval));
  if (item.price?.id === price) return current;
  return client.subscriptions.update(a.stripeSubscriptionId, {
    items: [{ id: item.id, price }],
    proration_behavior: "create_prorations",
    cancel_at_period_end: false,
    metadata: { ...current.metadata, kind: "plan", plan: a.plan, interval: a.interval, customer_id: a.customerId, environment: getStripeMode() },
  }, { idempotencyKey: `plan-change:${a.stripeSubscriptionId}:${a.plan}:${a.interval}:${item.price?.id ?? "none"}` });
}

/**
 * A new plan Checkout completed while an older plan subscription still exists (e.g. two Checkouts raced): cancel the
 * old one with proration so the customer is never billed twice. Never throws; returns whether it canceled.
 */
export async function cancelSupersededSubscription(oldSubscriptionId: string | null, newSubscriptionId: string | null): Promise<boolean> {
  if (!oldSubscriptionId || !newSubscriptionId || oldSubscriptionId === newSubscriptionId) return false;
  try {
    await stripe().subscriptions.cancel(oldSubscriptionId, { prorate: true }, { idempotencyKey: `supersede:${oldSubscriptionId}` });
    return true;
  } catch (err) {
    console.error("cancel superseded subscription failed", oldSubscriptionId, err instanceof Error ? err.message : err);
    return false;
  }
}

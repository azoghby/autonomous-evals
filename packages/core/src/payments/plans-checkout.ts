import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import {
  STRIPE_LOOKUP_KEYS, isBillingInterval, isPlanId, isSelfServePlanId, lookupKeyFor, productForLookupKey,
  type BillingInterval, type PlanId, type SelfServePlanId,
} from "../pricing/plans";
import { getStripeMode, stripe } from "./stripe";
import { isOperator } from "../auth/tokens";

const priceIdCache = new Map<string, string>();

/** Test hook: forget cached price ids. */
export function clearPriceCache(): void {
  priceIdCache.clear();
}

/** Resolves a Stripe price id from its lookup key (created by scripts/stripe-setup.ts). Cached per process. */
export async function resolvePriceId(lookupKey: string): Promise<string> {
  const hit = priceIdCache.get(lookupKey);
  if (hit) return hit;
  const res = await stripe().prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const id = res.data[0]?.id;
  if (!id) throw new Error(`Stripe price ${lookupKey} not found; run scripts/stripe-setup.ts`);
  priceIdCache.set(lookupKey, id);
  return id;
}

const utcDate = () => new Date().toISOString().slice(0, 10);

export interface PlanCheckoutArgs {
  customerId: string;
  customerEmail: string;
  stripeCustomerId?: string | null;
  plan: SelfServePlanId;
  interval: BillingInterval;
  successUrl: string;
  cancelUrl: string;
}

/** Subscription Checkout for Pro/Scale. Does not touch the database. */
export async function createPlanCheckout(a: PlanCheckoutArgs): Promise<{ sessionId: string; url: string }> {
  const price = await resolvePriceId(lookupKeyFor(a.plan, a.interval));
  const metadata = {
    kind: "plan", plan: a.plan, interval: a.interval, customer_id: a.customerId, environment: getStripeMode(),
  };
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: a.customerId,
    metadata,
    subscription_data: { metadata },
    allow_promotion_codes: true,
    ...(a.stripeCustomerId ? { customer: a.stripeCustomerId } : { customer_email: a.customerEmail }),
    success_url: a.successUrl,
    cancel_url: a.cancelUrl,
  }, { idempotencyKey: `plan:${a.customerId}:${a.plan}:${a.interval}:${utcDate()}` });
  if (!session.url) throw new Error("Stripe returned a checkout session without a URL");
  return { sessionId: session.id, url: session.url };
}

export interface AuditCheckoutArgs {
  customerId: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
}

/** One-off $2,500 Agent Audit Checkout. Does not touch the database. */
export async function createAuditCheckout(a: AuditCheckoutArgs): Promise<{ sessionId: string; url: string }> {
  const price = await resolvePriceId(STRIPE_LOOKUP_KEYS.agent_audit);
  const metadata = { kind: "agent_audit", customer_id: a.customerId, environment: getStripeMode() };
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [{ price, quantity: 1 }],
    customer_email: a.customerEmail,
    client_reference_id: a.customerId,
    metadata,
    payment_intent_data: { metadata },
    success_url: a.successUrl,
    cancel_url: a.cancelUrl,
  }, { idempotencyKey: `audit:${a.customerId}:${utcDate()}` });
  if (!session.url) throw new Error("Stripe returned a checkout session without a URL");
  return { sessionId: session.id, url: session.url };
}

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : v?.id ?? null);

export interface PlanPurchaseResult {
  inserted: boolean;
  kind: "plan" | "agent_audit";
  email: string;
  product: string;
  customerId: string | null;
}

/**
 * Records a paid plan/audit Checkout session. Idempotent on the unique session id. Only the first
 * insert updates the customer's plan, so a replayed old event never overwrites a newer plan.
 */
export async function recordPlanPurchase(session: Stripe.Checkout.Session, _eventId: string | null = null): Promise<PlanPurchaseResult> {
  const metaKind = session.metadata?.kind;
  if (metaKind !== "plan" && metaKind !== "agent_audit") throw new Error(`Session ${session.id} is not a plan/audit checkout`);
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    throw new Error(`Session ${session.id} is not paid (${session.payment_status})`);
  }
  const customerId = session.metadata?.customer_id ?? session.client_reference_id ?? null;
  const email = session.customer_details?.email ?? session.customer_email ?? "unknown";
  const plan = session.metadata?.plan;
  const interval = session.metadata?.interval;
  if (metaKind === "plan" && (!isSelfServePlanId(plan) || !isBillingInterval(interval))) {
    throw new Error(`Session ${session.id} has invalid plan/interval metadata`);
  }
  const product = metaKind === "plan" ? (plan as string) : "agent_audit";
  const stripeCustomerId = idOf(session.customer);
  const stripeSubscriptionId = idOf(session.subscription);

  const rows = await db().insert(schema.planPurchases).values({
    customerId, email,
    kind: metaKind === "plan" ? "subscription" : "audit",
    product,
    interval: metaKind === "plan" ? (interval as string) : null,
    amountCents: session.amount_total ?? 0,
    currency: session.currency ?? "usd",
    environment: session.livemode ? "live" : "test",
    stripeCheckoutSessionId: session.id,
    stripeSubscriptionId, stripeCustomerId,
    status: metaKind === "plan" ? "active" : "paid",
  }).onConflictDoNothing().returning();
  const inserted = rows.length > 0;

  if (inserted && metaKind === "plan" && customerId) {
    await db().update(schema.customers).set({
      plan: product, planInterval: interval as string, planStatus: "active",
      stripeCustomerId, stripeSubscriptionId, planUpdatedAt: new Date(),
    }).where(eq(schema.customers.id, customerId));
  }
  return { inserted, kind: metaKind, email, product, customerId };
}

const LAPSED_STATUSES = new Set(["canceled", "incomplete_expired", "unpaid"]);

/** Mirrors a Stripe subscription onto its customer. Returns the customer id, or null when it is not a plan subscription. */
export async function syncSubscription(subscription: Stripe.Subscription): Promise<string | null> {
  let [customer] = await db().select().from(schema.customers)
    .where(eq(schema.customers.stripeSubscriptionId, subscription.id)).limit(1);
  if (!customer) {
    // Monitoring subscriptions carry job_id metadata only; plan subscriptions carry customer_id.
    const metaId = subscription.metadata?.customer_id;
    if (!metaId || subscription.metadata?.kind !== "plan") return null;
    [customer] = await db().select().from(schema.customers).where(eq(schema.customers.id, metaId)).limit(1);
    // A different subscription already owns this customer's plan; this one is superseded.
    if (!customer || (customer.stripeSubscriptionId && customer.stripeSubscriptionId !== subscription.id)) return null;
  }

  const item = subscription.items?.data?.[0];
  const periodEnd = item?.current_period_end;
  const set: Partial<typeof schema.customers.$inferInsert> = {
    planStatus: subscription.status,
    planCurrentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: idOf(subscription.customer),
    planUpdatedAt: new Date(),
  };
  if (LAPSED_STATUSES.has(subscription.status)) {
    set.plan = "developer";
    set.planInterval = null;
  } else {
    const key = item?.price?.lookup_key;
    const product = key ? productForLookupKey(key) : null;
    if (product?.kind === "plan") {
      set.plan = product.plan;
      set.planInterval = product.interval;
    }
  }
  await db().update(schema.customers).set(set).where(eq(schema.customers.id, customer.id));
  return customer.id;
}

export interface PlanRow {
  plan: string;
  planStatus: string | null;
}

const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

/** Plan a customer is entitled to right now. past_due keeps access as a grace period; enterprise is operator-set. */
export function effectivePlanFor(row: PlanRow | null | undefined): PlanId {
  if (!row || !isPlanId(row.plan)) return "developer";
  if (row.plan === "enterprise" || row.plan === "developer") return row.plan;
  return row.planStatus && ACTIVE_STATUSES.has(row.planStatus) ? row.plan : "developer";
}

/**
 * Effective plan for a customer id. Internal fixtures (demo/public-agent accounts) and operators (OPERATOR_EMAILS)
 * are treated as enterprise so first-party runs are never stopped by free-plan limits.
 */
export async function getCustomerPlan(customerId: string): Promise<PlanId> {
  const [row] = await db().select({
    plan: schema.customers.plan, planStatus: schema.customers.planStatus,
    email: schema.customers.email, isInternalFixture: schema.customers.isInternalFixture,
  }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
  if (row && (row.isInternalFixture || (row.email && isOperator(row.email)))) return "enterprise";
  return effectivePlanFor(row);
}

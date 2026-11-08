import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeMock = {
  prices: { list: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
  subscriptions: { cancel: vi.fn() },
};
vi.mock("./stripe", () => ({ stripe: () => stripeMock, getStripeMode: () => "test" }));

let selects: unknown[][] = [];
let insertReturn: unknown[] = [{ id: "pp1" }];
const updates: Record<string, unknown>[] = [];
const inserts: Record<string, unknown>[] = [];
vi.mock("../db/client", () => {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "where"]) c[m] = () => c;
    c.limit = async () => selects.shift() ?? [];
    return c;
  };
  const database = {
    select: () => chain(),
    update: () => ({ set: (v: Record<string, unknown>) => { updates.push(v); return { where: async () => undefined }; } }),
    insert: () => ({ values: (v: Record<string, unknown>) => { inserts.push(v); return { onConflictDoNothing: () => ({ returning: async () => insertReturn }) }; } }),
  };
  return { db: () => database, schema: new Proxy({}, { get: () => new Proxy({}, { get: (_t, c) => String(c) }) }) };
});

import type Stripe from "stripe";
import {
  clearPriceCache, createAuditCheckout, createPlanCheckout, effectivePlanFor, getCustomerPlan, recordPlanPurchase,
  resolvePriceId, syncSubscription,
} from "./plans-checkout";

const URLS = { successUrl: "https://x/ok", cancelUrl: "https://x/no" };
const today = new Date().toISOString().slice(0, 10);

beforeEach(() => {
  vi.clearAllMocks(); clearPriceCache(); selects = []; insertReturn = [{ id: "pp1" }]; updates.length = 0; inserts.length = 0;
  stripeMock.prices.list.mockResolvedValue({ data: [{ id: "price_1" }] });
  stripeMock.checkout.sessions.create.mockResolvedValue({ id: "cs_1", url: "https://stripe/cs_1" });
});

describe("resolvePriceId", () => {
  it("looks up by lookup key and caches", async () => {
    expect(await resolvePriceId("se_pro_monthly_v1")).toBe("price_1");
    await resolvePriceId("se_pro_monthly_v1");
    expect(stripeMock.prices.list).toHaveBeenCalledTimes(1);
    expect(stripeMock.prices.list).toHaveBeenCalledWith({ lookup_keys: ["se_pro_monthly_v1"], active: true, limit: 1 });
  });
  it("throws a clear error when missing", async () => {
    stripeMock.prices.list.mockResolvedValue({ data: [] });
    await expect(resolvePriceId("nope")).rejects.toThrow("Stripe price nope not found; run scripts/stripe-setup.ts");
  });
});

describe("createPlanCheckout trial", () => {
  it("adds trial_period_days and metadata when trialDays is set", async () => {
    await createPlanCheckout({ customerId: "c1", customerEmail: "a@b.co", plan: "pro", interval: "month", trialDays: 14, ...URLS });
    const [arg] = stripeMock.checkout.sessions.create.mock.calls[0];
    expect(arg.subscription_data.trial_period_days).toBe(14);
    expect(arg.subscription_data.metadata.trial_days).toBe("14");
  });
  it("omits trial fields when trialDays is 0 or absent", async () => {
    await createPlanCheckout({ customerId: "c1", customerEmail: "a@b.co", plan: "pro", interval: "month", trialDays: 0, ...URLS });
    const [arg] = stripeMock.checkout.sessions.create.mock.calls[0];
    expect(arg.subscription_data).not.toHaveProperty("trial_period_days");
    expect(arg.metadata).not.toHaveProperty("trial_days");
  });
  it("treats a trialing subscription as entitled and mirrors trial_end", async () => {
    expect(effectivePlanFor({ plan: "pro", planStatus: "trialing" })).toBe("pro");
    selects = [[{ id: "c1", stripeSubscriptionId: "sub_1" }]];
    const trialEnd = 1_800_000_000;
    await syncSubscription({
      id: "sub_1", status: "trialing", trial_end: trialEnd, customer: "cus_1", metadata: {},
      items: { data: [{ current_period_end: trialEnd, price: { lookup_key: "se_pro_monthly_v1" } }] },
    } as unknown as Stripe.Subscription);
    expect(updates[0]).toMatchObject({ planStatus: "trialing", plan: "pro", planTrialEnd: new Date(trialEnd * 1000) });
  });
  it("clears planTrialEnd once the subscription is active", async () => {
    selects = [[{ id: "c1", stripeSubscriptionId: "sub_1" }]];
    await syncSubscription({
      id: "sub_1", status: "active", trial_end: 1_800_000_000, customer: "cus_1", metadata: {},
      items: { data: [{ current_period_end: 1_802_000_000, price: { lookup_key: "se_pro_monthly_v1" } }] },
    } as unknown as Stripe.Subscription);
    expect(updates[0]).toMatchObject({ planStatus: "active", planTrialEnd: null });
  });
  it("records a trial purchase as trialing", async () => {
    selects = [[{ sub: null, status: null }]];
    await recordPlanPurchase({
      id: "cs_t", payment_status: "no_payment_required", customer: "cus_1", subscription: "sub_1", amount_total: 0, currency: "usd", livemode: false,
      metadata: { kind: "plan", plan: "pro", interval: "month", customer_id: "c1", trial_days: "14" }, customer_email: "a@b.co",
    } as unknown as Stripe.Checkout.Session);
    expect(inserts[0]).toMatchObject({ status: "trialing" });
    expect(updates[0]).toMatchObject({ planStatus: "trialing", plan: "pro" });
    expect(updates[0]!.planTrialEnd).toBeInstanceOf(Date);
  });
});

describe("createPlanCheckout", () => {
  it("creates a subscription session with metadata, promo codes and customer_email", async () => {
    const out = await createPlanCheckout({ customerId: "c1", customerEmail: "a@b.co", plan: "pro", interval: "month", ...URLS });
    expect(out).toEqual({ sessionId: "cs_1", url: "https://stripe/cs_1" });
    const [params, opts] = stripeMock.checkout.sessions.create.mock.calls[0]!;
    const meta = { kind: "plan", plan: "pro", interval: "month", customer_id: "c1", environment: "test" };
    expect(params).toMatchObject({
      mode: "subscription", line_items: [{ price: "price_1", quantity: 1 }], client_reference_id: "c1",
      metadata: meta, subscription_data: { metadata: meta }, allow_promotion_codes: true, customer_email: "a@b.co",
    });
    expect(params.customer).toBeUndefined();
    expect(opts).toEqual({ idempotencyKey: `plan:c1:pro:month:${today}` });
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
  it("uses the existing Stripe customer instead of customer_email", async () => {
    await createPlanCheckout({ customerId: "c1", customerEmail: "a@b.co", stripeCustomerId: "cus_1", plan: "scale", interval: "year", ...URLS });
    const [params] = stripeMock.checkout.sessions.create.mock.calls[0]!;
    expect(params.customer).toBe("cus_1");
    expect(params.customer_email).toBeUndefined();
    expect(stripeMock.prices.list).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ["se_scale_annual_v1"] }));
  });
  it("throws when Stripe returns no URL", async () => {
    stripeMock.checkout.sessions.create.mockResolvedValue({ id: "cs_1", url: null });
    await expect(createPlanCheckout({ customerId: "c1", customerEmail: "a@b.co", plan: "pro", interval: "month", ...URLS })).rejects.toThrow(/without a URL/);
  });
});

describe("createAuditCheckout", () => {
  it("creates a one-off payment session", async () => {
    await createAuditCheckout({ customerId: "c1", customerEmail: "a@b.co", ...URLS });
    const [params, opts] = stripeMock.checkout.sessions.create.mock.calls[0]!;
    const meta = { kind: "agent_audit", customer_id: "c1", environment: "test" };
    expect(params).toMatchObject({ mode: "payment", metadata: meta, payment_intent_data: { metadata: meta }, customer_email: "a@b.co" });
    expect(stripeMock.prices.list).toHaveBeenCalledWith(expect.objectContaining({ lookup_keys: ["se_agent_audit_v1"] }));
    expect(opts).toEqual({ idempotencyKey: `audit:c1:${today}` });
  });
});

const session = (over: Record<string, unknown> = {}) => ({
  id: "cs_1", payment_status: "paid", livemode: false, amount_total: 49900, currency: "usd",
  customer: "cus_1", subscription: "sub_1", customer_details: { email: "a@b.co" },
  metadata: { kind: "plan", plan: "pro", interval: "month", customer_id: "c1" }, ...over,
}) as unknown as Stripe.Checkout.Session;

describe("recordPlanPurchase", () => {
  it("inserts the purchase and activates the plan", async () => {
    const r = await recordPlanPurchase(session(), "evt_1");
    expect(r).toMatchObject({ inserted: true, kind: "plan", email: "a@b.co", product: "pro" });
    expect(inserts[0]).toMatchObject({ kind: "subscription", product: "pro", interval: "month", amountCents: 49900, stripeSubscriptionId: "sub_1" });
    expect(updates[0]).toMatchObject({ plan: "pro", planInterval: "month", planStatus: "active", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" });
  });
  it("cancels a still-active older plan subscription so the customer is never billed twice", async () => {
    selects = [[{ sub: "sub_old", status: "active" }]];
    stripeMock.subscriptions.cancel.mockResolvedValue({});
    await recordPlanPurchase(session(), "evt_1");
    expect(stripeMock.subscriptions.cancel).toHaveBeenCalledWith("sub_old", { prorate: true }, { idempotencyKey: "supersede:sub_old" });
  });
  it("does not cancel anything when the older subscription already lapsed", async () => {
    selects = [[{ sub: "sub_old", status: "canceled" }]];
    await recordPlanPurchase(session(), "evt_1");
    expect(stripeMock.subscriptions.cancel).not.toHaveBeenCalled();
  });
  it("is idempotent: a duplicate does not touch the customer", async () => {
    insertReturn = [];
    const r = await recordPlanPurchase(session());
    expect(r.inserted).toBe(false);
    expect(updates).toHaveLength(0);
  });
  it("accepts no_payment_required (100% promo)", async () => {
    expect((await recordPlanPurchase(session({ payment_status: "no_payment_required", amount_total: 0 }))).inserted).toBe(true);
  });
  it("audit inserts a purchase only", async () => {
    const r = await recordPlanPurchase(session({ mode: "payment", subscription: null, amount_total: 250000, metadata: { kind: "agent_audit", customer_id: "c1" } }));
    expect(r).toMatchObject({ inserted: true, kind: "agent_audit", product: "agent_audit" });
    expect(inserts[0]).toMatchObject({ kind: "audit", product: "agent_audit", interval: null, status: "paid" });
    expect(updates).toHaveLength(0);
  });
  it("rejects unpaid sessions and non-plan sessions", async () => {
    await expect(recordPlanPurchase(session({ payment_status: "unpaid" }))).rejects.toThrow(/not paid/);
    await expect(recordPlanPurchase(session({ metadata: { job_id: "j" } }))).rejects.toThrow(/not a plan/);
  });
});

const sub = (over: Record<string, unknown> = {}) => ({
  id: "sub_1", status: "active", customer: "cus_1", metadata: { kind: "plan", customer_id: "c1" },
  items: { data: [{ current_period_end: 1_800_000_000, price: { lookup_key: "se_scale_annual_v1" } }] }, ...over,
}) as unknown as Stripe.Subscription;

describe("syncSubscription", () => {
  it("mirrors status, period end and a portal plan change", async () => {
    selects = [[{ id: "c1" }]];
    expect(await syncSubscription(sub())).toBe("c1");
    expect(updates[0]).toMatchObject({ planStatus: "active", plan: "scale", planInterval: "year" });
    expect(updates[0]!.planCurrentPeriodEnd).toEqual(new Date(1_800_000_000_000));
  });
  it("downgrades to developer when canceled", async () => {
    selects = [[{ id: "c1" }]];
    await syncSubscription(sub({ status: "canceled" }));
    expect(updates[0]).toMatchObject({ planStatus: "canceled", plan: "developer", planInterval: null });
  });
  it("falls back to metadata customer_id when the subscription id is not stored yet", async () => {
    selects = [[], [{ id: "c1", stripeSubscriptionId: null }]];
    expect(await syncSubscription(sub())).toBe("c1");
  });
  it("ignores monitoring subscriptions and superseded subscriptions", async () => {
    selects = [[]];
    expect(await syncSubscription(sub({ metadata: { job_id: "j1", kind: "monitoring" } }))).toBeNull();
    selects = [[], [{ id: "c1", stripeSubscriptionId: "sub_other" }]];
    expect(await syncSubscription(sub())).toBeNull();
    expect(updates).toHaveLength(0);
  });
});

describe("effectivePlanFor / getCustomerPlan", () => {
  it("grants paid plans only for active-ish statuses", () => {
    expect(effectivePlanFor({ plan: "pro", planStatus: "active" })).toBe("pro");
    expect(effectivePlanFor({ plan: "scale", planStatus: "trialing" })).toBe("scale");
    expect(effectivePlanFor({ plan: "pro", planStatus: "past_due" })).toBe("pro");
    expect(effectivePlanFor({ plan: "pro", planStatus: "canceled" })).toBe("developer");
    expect(effectivePlanFor({ plan: "pro", planStatus: null })).toBe("developer");
  });
  it("keeps enterprise regardless of status and defaults unknowns to developer", () => {
    expect(effectivePlanFor({ plan: "enterprise", planStatus: null })).toBe("enterprise");
    expect(effectivePlanFor({ plan: "bogus", planStatus: "active" })).toBe("developer");
    expect(effectivePlanFor(undefined)).toBe("developer");
  });
  it("reads the customer row", async () => {
    selects = [[{ plan: "pro", planStatus: "active" }]];
    expect(await getCustomerPlan("c1")).toBe("pro");
    selects = [[]];
    expect(await getCustomerPlan("c1")).toBe("developer");
  });
  it("treats internal fixtures and operators as enterprise", async () => {
    selects = [[{ plan: "developer", planStatus: null, email: "x@example.com", isInternalFixture: true }]];
    expect(await getCustomerPlan("c1")).toBe("enterprise");
    const prev = process.env.OPERATOR_EMAILS;
    process.env.OPERATOR_EMAILS = "ops@example.com";
    selects = [[{ plan: "developer", planStatus: null, email: "Ops@example.com", isInternalFixture: false }]];
    expect(await getCustomerPlan("c1")).toBe("enterprise");
    process.env.OPERATOR_EMAILS = prev;
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const me = vi.hoisted(() => ({ value: null as null | { id: string; email: string; isOperator: boolean } }));
const row = vi.hoisted(() => ({ value: undefined as undefined | Record<string, unknown> }));
const plans = vi.hoisted(() => ({ plan: vi.fn(), audit: vi.fn(), change: vi.fn(), sync: vi.fn() }));

vi.mock("@/server/queries", () => ({ getCurrentCustomer: async () => me.value }));
vi.mock("@/server/session", () => ({ getCurrentCustomer: async () => me.value }));
const purchases = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock("@ae/core/db/client", () => {
  const schema = { customers: new Proxy({}, { get: (_t, c) => String(c) }), planPurchases: new Proxy({}, { get: (_t, c) => String(c) }) };
  return {
    db: () => ({
      select: () => ({
        from: (t: unknown) => ({ where: () => ({ limit: async () => (t === schema.planPurchases ? purchases.value : row.value ? [row.value] : []) }) }),
      }),
    }),
    schema,
  };
});
vi.mock("@ae/core/payments/plans-checkout", async (orig) => {
  const actual = await orig<typeof import("@ae/core/payments/plans-checkout")>();
  return { ...actual, createPlanCheckout: plans.plan, createAuditCheckout: plans.audit, syncSubscription: plans.sync };
});
vi.mock("@ae/core/payments/subscription-changes", () => ({ changePlanSubscription: plans.change }));

import { POST } from "./route";

const post = (body: unknown) => POST(new Request("https://app.test/api/billing/checkout", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  me.value = { id: "c1", email: "a@b.co", isOperator: false };
  row.value = { plan: "developer", planStatus: null, stripeCustomerId: null };
  plans.plan.mockResolvedValue({ sessionId: "cs_1", url: "https://stripe/plan" });
  plans.audit.mockResolvedValue({ sessionId: "cs_2", url: "https://stripe/audit" });
  purchases.value = [];
  delete process.env.APP_URL;
});

describe("POST /api/billing/checkout", () => {
  it("401s with a signin URL when signed out", async () => {
    me.value = null;
    const res = await post({ kind: "audit" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in to continue", signinUrl: "/signin?next=/pricing" });
  });
  it("400s on an invalid body", async () => {
    for (const b of [{}, { kind: "plan", plan: "enterprise", interval: "month" }, { kind: "plan", plan: "pro" }]) {
      const res = await post(b);
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty("error");
    }
  });
  it("returns the Stripe URL for a plan with pricing return URLs", async () => {
    const res = await post({ kind: "plan", plan: "pro", interval: "year" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://stripe/plan" });
    expect(plans.plan).toHaveBeenCalledWith(expect.objectContaining({
      customerId: "c1", plan: "pro", interval: "year",
      successUrl: "https://app.test/pricing?checkout=success&plan=pro", cancelUrl: "https://app.test/pricing?checkout=cancelled",
    }));
  });
  it("includes a 14-day trial on a first Pro checkout", async () => {
    await post({ kind: "plan", plan: "pro", interval: "month" });
    expect(plans.plan).toHaveBeenCalledWith(expect.objectContaining({ trialDays: 14 }));
  });
  it("gives no trial on Scale", async () => {
    await post({ kind: "plan", plan: "scale", interval: "month" });
    expect(plans.plan).toHaveBeenCalledWith(expect.objectContaining({ trialDays: 0 }));
  });
  it("gives no second trial after an earlier subscription purchase", async () => {
    purchases.value = [{ id: "pp1" }];
    await post({ kind: "plan", plan: "pro", interval: "month" });
    expect(plans.plan).toHaveBeenCalledWith(expect.objectContaining({ trialDays: 0 }));
  });
  it("gives no second trial to a lapsed customer who still has a stored subscription id", async () => {
    row.value = { plan: "developer", planStatus: "canceled", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_old" };
    await post({ kind: "plan", plan: "pro", interval: "month" });
    expect(plans.plan).toHaveBeenCalledWith(expect.objectContaining({ trialDays: 0 }));
  });
  it("409s when already on that plan and active", async () => {
    row.value = { plan: "pro", planStatus: "active", stripeCustomerId: "cus_1" };
    expect((await post({ kind: "plan", plan: "pro", interval: "month" })).status).toBe(409);
    expect(plans.plan).not.toHaveBeenCalled();
  });
  it("allows upgrading and re-buying a canceled plan, reusing the Stripe customer", async () => {
    row.value = { plan: "pro", planStatus: "canceled", stripeCustomerId: "cus_1" };
    expect((await post({ kind: "plan", plan: "pro", interval: "month" })).status).toBe(200);
    expect(plans.plan).toHaveBeenCalledWith(expect.objectContaining({ stripeCustomerId: "cus_1" }));
  });
  it("switches an active plan subscription in place instead of creating a second one", async () => {
    row.value = { plan: "pro", planStatus: "active", planInterval: "month", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" };
    plans.change.mockResolvedValue({ id: "sub_1", status: "active" });
    const res = await post({ kind: "plan", plan: "scale", interval: "month" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://app.test/settings/billing?changed=scale", changed: true });
    expect(plans.change).toHaveBeenCalledWith(
      { customerId: "c1", stripeSubscriptionId: "sub_1", plan: "scale", interval: "month" }, expect.any(Function),
    );
    expect(plans.sync).toHaveBeenCalledWith({ id: "sub_1", status: "active" });
    expect(plans.plan).not.toHaveBeenCalled();
  });
  it("switches monthly to annual on the same plan in place", async () => {
    row.value = { plan: "pro", planStatus: "active", planInterval: "month", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" };
    plans.change.mockResolvedValue({ id: "sub_1" });
    expect((await post({ kind: "plan", plan: "pro", interval: "year" })).status).toBe(200);
    expect(plans.change).toHaveBeenCalledWith(expect.objectContaining({ plan: "pro", interval: "year" }), expect.any(Function));
    expect(plans.plan).not.toHaveBeenCalled();
  });
  it("starts an audit checkout", async () => {
    const res = await post({ kind: "audit" });
    expect(await res.json()).toEqual({ url: "https://stripe/audit" });
    expect(plans.audit).toHaveBeenCalledWith(expect.objectContaining({ successUrl: "https://app.test/pricing?checkout=success&plan=agent_audit" }));
  });
  it("502s with a public-safe message on Stripe errors", async () => {
    plans.plan.mockRejectedValue(new Error("Stripe price se_pro_monthly_v1 not found; run scripts/stripe-setup.ts"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await post({ kind: "plan", plan: "pro", interval: "month" });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toMatch(/stripe-setup|se_pro/);
  });
});

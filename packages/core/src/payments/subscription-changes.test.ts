import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeMock = {
  subscriptions: { retrieve: vi.fn(), update: vi.fn(), cancel: vi.fn() },
};
vi.mock("./stripe", () => ({ stripe: () => stripeMock, getStripeMode: () => "test" }));

const updates: Array<Record<string, unknown>> = [];
let returned: unknown[] = [];
vi.mock("../db/client", () => ({
  db: () => ({
    update: () => ({ set: (v: Record<string, unknown>) => { updates.push(v); return { where: () => ({ returning: async () => returned }) }; } }),
  }),
  schema: new Proxy({}, { get: () => new Proxy({}, { get: (_t, c) => String(c) }) }),
}));

import type Stripe from "stripe";
import { RUNNABLE_MONITORING_STATUSES, cancelSupersededSubscription, changePlanSubscription, syncMonitoringSubscription } from "./subscription-changes";

beforeEach(() => {
  vi.clearAllMocks(); updates.length = 0; returned = [];
});

describe("syncMonitoringSubscription", () => {
  it("mirrors the Stripe status onto the monitoring row", async () => {
    returned = [{ id: "m1" }];
    const n = await syncMonitoringSubscription({ id: "sub_m", status: "canceled" } as Stripe.Subscription);
    expect(n).toBe(1);
    expect(updates).toEqual([{ status: "canceled" }]);
  });
  it("only active and trialing subscriptions are runnable", () => {
    expect([...RUNNABLE_MONITORING_STATUSES]).toEqual(["active", "trialing"]);
  });
});

describe("changePlanSubscription", () => {
  const resolve = vi.fn(async (key: string) => (key === "se_scale_monthly_v1" ? "price_scale" : "price_pro"));
  it("swaps the price on the existing item with proration", async () => {
    stripeMock.subscriptions.retrieve.mockResolvedValue({ id: "sub_1", metadata: { kind: "plan" }, items: { data: [{ id: "si_1", price: { id: "price_pro" } }] } });
    stripeMock.subscriptions.update.mockResolvedValue({ id: "sub_1", status: "active" });
    const out = await changePlanSubscription({ customerId: "c1", stripeSubscriptionId: "sub_1", plan: "scale", interval: "month" }, resolve);
    expect(out).toEqual({ id: "sub_1", status: "active" });
    const [id, params, opts] = stripeMock.subscriptions.update.mock.calls[0]!;
    expect(id).toBe("sub_1");
    expect(params).toMatchObject({ items: [{ id: "si_1", price: "price_scale" }], proration_behavior: "create_prorations", metadata: { plan: "scale", customer_id: "c1" } });
    expect(opts.idempotencyKey).toBe("plan-change:sub_1:scale:month:price_pro");
  });
  it("is a no-op when already on that price", async () => {
    const sub = { id: "sub_1", metadata: {}, items: { data: [{ id: "si_1", price: { id: "price_scale" } }] } };
    stripeMock.subscriptions.retrieve.mockResolvedValue(sub);
    expect(await changePlanSubscription({ customerId: "c1", stripeSubscriptionId: "sub_1", plan: "scale", interval: "month" }, resolve)).toBe(sub);
    expect(stripeMock.subscriptions.update).not.toHaveBeenCalled();
  });
});

describe("cancelSupersededSubscription", () => {
  it("cancels the older subscription with proration", async () => {
    stripeMock.subscriptions.cancel.mockResolvedValue({});
    expect(await cancelSupersededSubscription("sub_old", "sub_new")).toBe(true);
    expect(stripeMock.subscriptions.cancel).toHaveBeenCalledWith("sub_old", { prorate: true }, { idempotencyKey: "supersede:sub_old" });
  });
  it("does nothing without an older, different subscription", async () => {
    expect(await cancelSupersededSubscription(null, "sub_new")).toBe(false);
    expect(await cancelSupersededSubscription("sub_1", "sub_1")).toBe(false);
    expect(stripeMock.subscriptions.cancel).not.toHaveBeenCalled();
  });
  it("never throws when Stripe fails", async () => {
    stripeMock.subscriptions.cancel.mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await cancelSupersededSubscription("sub_old", "sub_new")).toBe(false);
  });
});

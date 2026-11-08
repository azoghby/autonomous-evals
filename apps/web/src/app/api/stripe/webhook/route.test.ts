import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] }));
const resume = vi.hoisted(() => ({ fn: vi.fn() }));

// Minimal in-memory stand-in for the drizzle calls recordPaymentFromSession makes.
vi.mock("@ae/core/db/client", async (orig) => {
  const actual = await orig<typeof import("@ae/core/db/client")>();
  const fake = {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (store.rows.some((r) => r.stripeCheckoutSessionId === v.stripeCheckoutSessionId || (v.stripeEventId && r.stripeEventId === v.stripeEventId))) return [];
            const row = { id: crypto.randomUUID(), workflowResumedAt: null, ...v };
            store.rows.push(row);
            return [row];
          },
        }),
      }),
    }),
    update: () => ({ set: (v: Record<string, unknown>) => { store.updates.push(v); return { where: async () => undefined }; } }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [store.rows[0]] }) }) }),
  };
  return { ...actual, db: () => fake };
});
const alerts = vi.hoisted(() => ({ fn: vi.fn() }));
const sync = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/server/operator-alerts", () => ({ alertOperators: (a: unknown) => alerts.fn(a) }));
vi.mock("@ae/core/payments/plans-checkout", async (orig) => {
  const actual = await orig<typeof import("@ae/core/payments/plans-checkout")>();
  return { ...actual, syncSubscription: (s: unknown) => sync.fn(s) };
});
const monSync = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@ae/core/payments/subscription-changes", () => ({ syncMonitoringSubscription: (s: unknown) => monSync.fn(s), cancelSupersededSubscription: async () => false }));
vi.mock("../../../../workflows/resume", () => ({
  resumeJobForPayment: async (p: Record<string, unknown>) => {
    await resume.fn(p);
    p.workflowResumedAt = new Date(); // mirrors confirmAndResume stamping the row
  },
}));

import { POST } from "./route";

const SECRET = "whsec_test_secret";
const JOB = "22222222-2222-4222-8222-222222222222";

function eventBody(id = "evt_1", sessionId = "cs_test_1", paymentStatus = "paid") {
  return JSON.stringify({
    id, object: "event", type: "checkout.session.completed", livemode: false,
    data: { object: {
      id: sessionId, object: "checkout.session", mode: "payment", payment_status: paymentStatus, livemode: false,
      amount_total: 500, currency: "usd", payment_intent: "pi_1", metadata: { job_id: JOB, quote_version: "1", environment: "test" },
    } },
  });
}
const signed = (body: string) => new Request("http://localhost/api/stripe/webhook", {
  method: "POST", body,
  headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET }) },
});

beforeEach(() => {
  store.rows.length = 0; store.updates.length = 0;
  resume.fn.mockReset(); alerts.fn.mockReset(); alerts.fn.mockResolvedValue(true); sync.fn.mockReset(); sync.fn.mockResolvedValue("c1");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_dummy");
  vi.stubEnv("STRIPE_MODE", "test");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
});
afterEach(() => vi.unstubAllEnvs());

describe("stripe webhook", () => {
  it("rejects a bad signature with 400 and records nothing", async () => {
    const body = eventBody();
    const res = await POST(new Request("http://localhost/api/stripe/webhook", {
      method: "POST", body,
      headers: { "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_wrong" }) },
    }));
    expect(res.status).toBe(400);
    expect(store.rows).toHaveLength(0);
    expect(resume.fn).not.toHaveBeenCalled();
  });

  it("rejects a missing signature header", async () => {
    expect((await POST(new Request("http://localhost/x", { method: "POST", body: "{}" }))).status).toBe(400);
  });

  it("records the payment and resumes the job on a valid event", async () => {
    const res = await POST(signed(eventBody()));
    expect(res.status).toBe(200);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ jobId: JOB, quoteVersion: 1, amountCents: 500, kind: "one_time" });
    expect(resume.fn).toHaveBeenCalledTimes(1);
  });

  it("a duplicate event yields one payment row and one resume", async () => {
    await POST(signed(eventBody()));
    const again = await POST(signed(eventBody()));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(store.rows).toHaveLength(1);
    expect(resume.fn).toHaveBeenCalledTimes(1);
  });

  it("a second event for the same session does not resume again", async () => {
    await POST(signed(eventBody("evt_1", "cs_test_1")));
    await POST(signed(eventBody("evt_2", "cs_test_1")));
    expect(store.rows).toHaveLength(1);
    expect(resume.fn).toHaveBeenCalledTimes(1);
  });

  it("ignores unpaid sessions (async payment pending)", async () => {
    const res = await POST(signed(eventBody("evt_3", "cs_test_3", "unpaid")));
    expect(res.status).toBe(200);
    expect(store.rows).toHaveLength(0);
  });

  it("returns 500 when resume throws so Stripe retries, leaving the row resumable", async () => {
    resume.fn.mockRejectedValueOnce(new Error("workflow down"));
    const res = await POST(signed(eventBody()));
    expect(res.status).toBe(500);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.workflowResumedAt).toBeNull();
    // Stripe retries: the same event now resumes without a second row.
    const retry = await POST(signed(eventBody()));
    expect(retry.status).toBe(200);
    expect(store.rows).toHaveLength(1);
    expect(resume.fn).toHaveBeenCalledTimes(2);
  });

  it("returns 500 when the server is misconfigured", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    expect((await POST(signed(eventBody()))).status).toBe(500);
  });

  const planEvent = (id: string, metadata: Record<string, string>, mode = "subscription") => JSON.stringify({
    id, object: "event", type: "checkout.session.completed", livemode: false,
    data: { object: {
      id: `cs_${id}`, object: "checkout.session", mode, payment_status: "paid", livemode: false, amount_total: 49900, currency: "usd",
      customer: "cus_1", subscription: mode === "subscription" ? "sub_1" : null, customer_details: { email: "a@b.co" }, metadata,
    } },
  });

  it("activates a plan purchase without touching the job workflow", async () => {
    const res = await POST(signed(planEvent("evt_p", { kind: "plan", plan: "pro", interval: "month", customer_id: "c1" })));
    expect(res.status).toBe(200);
    expect(store.rows[0]).toMatchObject({ kind: "subscription", product: "pro", customerId: "c1" });
    expect(store.updates[0]).toMatchObject({ plan: "pro", planStatus: "active" });
    expect(resume.fn).not.toHaveBeenCalled();
    expect(alerts.fn).not.toHaveBeenCalled();
  });

  it("records an audit and alerts operators once; alert failure does not 500", async () => {
    alerts.fn.mockRejectedValueOnce(new Error("smtp down"));
    const body = planEvent("evt_a", { kind: "agent_audit", customer_id: "c1" }, "payment");
    expect((await POST(signed(body))).status).toBe(200);
    expect(store.rows[0]).toMatchObject({ kind: "audit", product: "agent_audit" });
    expect(alerts.fn).toHaveBeenCalledWith(expect.objectContaining({ detail: expect.stringContaining("a@b.co") }));
    expect((await POST(signed(body))).status).toBe(200);
    expect(alerts.fn).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1);
  });

  it("routes customer.subscription.deleted to syncSubscription", async () => {
    const body = JSON.stringify({ id: "evt_s", object: "event", type: "customer.subscription.deleted", livemode: false,
      data: { object: { id: "sub_1", object: "subscription", status: "canceled", metadata: {} } } });
    const res = await POST(signed(body));
    expect(res.status).toBe(200);
    expect(sync.fn).toHaveBeenCalledWith(expect.objectContaining({ id: "sub_1" }));
    expect(await res.json()).toMatchObject({ synced: true });
  });

  it("syncs monitoring subscription status instead of ignoring it", async () => {
    monSync.fn.mockResolvedValueOnce(1);
    const body = JSON.stringify({ id: "evt_m", object: "event", type: "customer.subscription.deleted", livemode: false,
      data: { object: { id: "sub_mon", object: "subscription", status: "canceled", metadata: { kind: "monitoring", job_id: JOB } } } });
    const res = await POST(signed(body));
    expect(res.status).toBe(200);
    expect(monSync.fn).toHaveBeenCalledWith(expect.objectContaining({ id: "sub_mon", status: "canceled" }));
    expect(sync.fn).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ synced: true });
  });

  it("returns 500 when subscription sync throws", async () => {
    sync.fn.mockRejectedValueOnce(new Error("db"));
    const body = JSON.stringify({ id: "evt_s2", object: "event", type: "customer.subscription.updated", livemode: false,
      data: { object: { id: "sub_1", object: "subscription", status: "active", metadata: {} } } });
    expect((await POST(signed(body))).status).toBe(500);
  });
});

import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
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
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [store.rows[0]] }) }) }),
  };
  return { ...actual, db: () => fake };
});
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
  store.rows.length = 0;
  resume.fn.mockReset();
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
});

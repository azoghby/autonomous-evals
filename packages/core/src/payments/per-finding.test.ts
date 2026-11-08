import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeMock = {
  paymentIntents: { retrieve: vi.fn(), capture: vi.fn(), cancel: vi.fn() },
  checkout: { sessions: { create: vi.fn() } },
};
vi.mock("./stripe", () => ({ stripe: () => stripeMock, getStripeMode: () => "test" }));

let selectRows: unknown[] = [];
const updates: unknown[] = [];
let insertedValues: Record<string, unknown> | undefined;
vi.mock("../db/client", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "innerJoin", "where", "orderBy"]) chain[m] = () => chain;
  chain.limit = async () => selectRows;
  const database = {
    select: () => chain,
    update: () => ({ set: (v: unknown) => ({ where: async () => { updates.push(v); } }) }),
    insert: () => ({ values: (v: Record<string, unknown>) => { insertedValues = v; return { onConflictDoNothing: () => ({ returning: async () => [{ id: "p1", ...v }] }) }; } }),
  };
  return { db: () => database, schema: new Proxy({}, { get: () => new Proxy({}, { get: (_t, c) => String(c) }) }) };
});

import { createCheckoutForQuote, isManualCaptureAuthorized, recordPaymentFromSession, settlePerFindingPayment } from "./checkout";

const session = (over: Record<string, unknown> = {}) => ({
  id: "cs_1", mode: "payment", status: "complete", payment_status: "unpaid", payment_intent: "pi_1",
  metadata: { job_id: "j1", quote_version: "1", pricing_mode: "per_finding" }, amount_total: 25000, currency: "usd", livemode: false, ...over,
}) as never;

beforeEach(() => {
  vi.clearAllMocks(); updates.length = 0; insertedValues = undefined; selectRows = [];
});

describe("manual-capture checkout", () => {
  it("creates a manual-capture session for the cap with per_finding metadata", async () => {
    stripeMock.checkout.sessions.create.mockResolvedValue({ id: "cs_1", url: "https://x" });
    await createCheckoutForQuote({ jobId: "j1", quoteVersion: 1, priceCents: 25000, pricingMode: "per_finding", customerEmail: "a@b.c", successUrl: "s", cancelUrl: "c" });
    const [params] = stripeMock.checkout.sessions.create.mock.calls[0]!;
    expect(params.line_items[0].price_data.unit_amount).toBe(25000);
    expect(params.payment_intent_data.capture_method).toBe("manual");
    expect(params.metadata.pricing_mode).toBe("per_finding");
  });
  it("fixed sessions stay automatic capture", async () => {
    stripeMock.checkout.sessions.create.mockResolvedValue({ id: "cs_2", url: "https://x" });
    await createCheckoutForQuote({ jobId: "j1", quoteVersion: 1, priceCents: 4900, customerEmail: "a@b.c", successUrl: "s", cancelUrl: "c" });
    const [params] = stripeMock.checkout.sessions.create.mock.calls[0]!;
    expect(params.payment_intent_data.capture_method).toBeUndefined();
    expect(params.metadata.pricing_mode).toBe("fixed");
  });
});

describe("webhook handling of manual-capture sessions", () => {
  it("treats unpaid + requires_capture as authorized and records status 'authorized'", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue({ status: "requires_capture" });
    expect(await isManualCaptureAuthorized(session())).toBe(true);
    const { payment, inserted } = await recordPaymentFromSession(session(), "evt_1");
    expect(inserted).toBe(true);
    expect(insertedValues).toMatchObject({ status: "authorized", amountCents: 25000, stripeCheckoutSessionId: "cs_1" });
    expect(payment.status).toBe("authorized");
  });
  it("rejects unpaid sessions whose intent is not holding funds, and non per_finding unpaid sessions", async () => {
    stripeMock.paymentIntents.retrieve.mockResolvedValue({ status: "requires_payment_method" });
    expect(await isManualCaptureAuthorized(session())).toBe(false);
    await expect(recordPaymentFromSession(session(), "evt_1")).rejects.toThrow(/not paid/);
    expect(await isManualCaptureAuthorized(session({ metadata: { job_id: "j1", quote_version: "1", pricing_mode: "fixed" } }))).toBe(false);
  });
  it("fixed paid sessions still record as 'paid' without calling Stripe", async () => {
    const paid = session({ payment_status: "paid", metadata: { job_id: "j1", quote_version: "1", pricing_mode: "fixed" } });
    await recordPaymentFromSession(paid, "evt_2");
    expect(insertedValues).toMatchObject({ status: "paid" });
    expect(stripeMock.paymentIntents.retrieve).not.toHaveBeenCalled();
  });
});

describe("settlePerFindingPayment", () => {
  const row = (status = "authorized") => [{
    payment: { id: "p1", status, amountCents: 25000, stripePaymentIntentId: "pi_1", capturedAmountCents: status === "captured" ? 5000 : null },
    quote: { pricingMode: "per_finding", capCents: 25000 },
  }];
  it("captures min(count*2500, cap) with the capture idempotency key", async () => {
    selectRows = row();
    expect(await settlePerFindingPayment("j1", 2)).toEqual({ outcome: "captured", confirmedCount: 2, amountCents: 5000 });
    expect(stripeMock.paymentIntents.capture).toHaveBeenCalledWith("pi_1", { amount_to_capture: 5000 }, { idempotencyKey: "capture:j1" });
    expect(updates[0]).toEqual({ status: "captured", capturedAmountCents: 5000 });
  });
  it("caps the capture", async () => {
    selectRows = row();
    expect((await settlePerFindingPayment("j1", 40)).amountCents).toBe(25000);
  });
  it("releases the authorization when nothing is confirmed", async () => {
    selectRows = row();
    expect(await settlePerFindingPayment("j1", 0)).toMatchObject({ outcome: "released", amountCents: 0 });
    expect(stripeMock.paymentIntents.cancel).toHaveBeenCalledWith("pi_1", undefined, { idempotencyKey: "release:j1" });
    expect(stripeMock.paymentIntents.capture).not.toHaveBeenCalled();
    expect(updates[0]).toEqual({ status: "released", capturedAmountCents: 0 });
  });
  it("is a no-op when already settled or not per_finding", async () => {
    selectRows = row("captured");
    expect((await settlePerFindingPayment("j1", 3)).outcome).toBe("already_settled");
    selectRows = [];
    expect((await settlePerFindingPayment("j1", 3)).outcome).toBe("not_applicable");
    expect(stripeMock.paymentIntents.capture).not.toHaveBeenCalled();
  });
});

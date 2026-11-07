import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeMock = {
  paymentIntents: { cancel: vi.fn(), capture: vi.fn(), retrieve: vi.fn() },
  checkout: { sessions: { expire: vi.fn() } },
};
vi.mock("./stripe", () => ({ stripe: () => stripeMock, getStripeMode: () => "test" }));

/** select() results are consumed in order; update().returning() yields `claimRows`. */
let selects: unknown[][] = [];
let claimRows: unknown[] = [{ id: "p1" }];
const updates: Record<string, unknown>[] = [];
const inserts: Record<string, unknown>[] = [];
vi.mock("../db/client", () => {
  const chain = (): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy", "innerJoin"]) c[m] = () => c;
    c.limit = async () => selects.shift() ?? [];
    return c;
  };
  const database = {
    select: () => chain(),
    update: () => ({ set: (v: Record<string, unknown>) => { updates.push(v); return { where: () => Object.assign(Promise.resolve(), { returning: async () => claimRows }) }; } }),
    insert: () => ({ values: (v: Record<string, unknown>) => { inserts.push(v); return { onConflictDoNothing: () => ({ returning: async () => [v] }) }; } }),
  };
  return { db: () => database, schema: new Proxy({}, { get: () => new Proxy({}, { get: (_t, c) => String(c) }) }) };
});

import { confirmAndResume, expireOpenCheckout, type PaymentRow } from "./checkout";

const payment = (over: Partial<PaymentRow> = {}) => ({
  id: "p1", jobId: "j1", quoteVersion: 1, kind: "one_time", status: "paid", amountCents: 4900, currency: "usd",
  stripePaymentIntentId: "pi_1", workflowResumedAt: null, ...over,
}) as PaymentRow;
const quote = (over: Record<string, unknown> = {}) => ({ version: 1, pricingMode: "fixed", priceCents: 4900, capCents: null, ...over });
const stamped = () => updates.some((u) => u.workflowResumedAt instanceof Date);

beforeEach(() => {
  vi.clearAllMocks(); selects = []; updates.length = 0; inserts.length = 0; claimRows = [{ id: "p1" }];
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
});

describe("expireOpenCheckout", () => {
  it("expires the latest quote's session", async () => {
    selects = [[{ sessionId: "cs_1" }]];
    expect(await expireOpenCheckout("j1")).toBe("expired");
    expect(stripeMock.checkout.sessions.expire).toHaveBeenCalledWith("cs_1");
  });
  it("tolerates an already expired/complete session", async () => {
    selects = [[{ sessionId: "cs_1" }]];
    stripeMock.checkout.sessions.expire.mockRejectedValue(new Error("Only open sessions can be expired"));
    expect(await expireOpenCheckout("j1")).toBe("skipped");
  });
  it("skips with a warning when STRIPE_SECRET_KEY is missing", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await expireOpenCheckout("j1")).toBe("skipped");
    expect(warn).toHaveBeenCalled();
    expect(stripeMock.checkout.sessions.expire).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("late payment after cancel", () => {
  it("releases a per_finding authorization immediately and stamps it", async () => {
    selects = [[{ state: "cancelled" }]];
    const send = vi.fn();
    expect(await confirmAndResume(payment({ status: "authorized", amountCents: 1500 }), send)).toBe("needs_review");
    expect(stripeMock.paymentIntents.cancel).toHaveBeenCalledWith("pi_1", undefined, { idempotencyKey: "release-late:p1" });
    expect(updates[0]).toMatchObject({ status: "released", capturedAmountCents: 0 });
    expect(stamped()).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
  it("marks a paid fixed payment needs_refund, opens a refund intervention, never refunds, and stamps", async () => {
    selects = [[{ state: "cancelled" }]];
    const send = vi.fn();
    expect(await confirmAndResume(payment(), send)).toBe("needs_review");
    expect(updates[0]).toMatchObject({ status: "needs_refund" });
    expect(inserts[0]).toMatchObject({ jobId: "j1", kind: "refund" });
    expect(String(inserts[0]!.note)).toContain("49.00 USD");
    expect(stripeMock.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(stamped()).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
  it("treats a stale quote version the same way", async () => {
    selects = [[{ state: "awaiting_payment" }], [quote({ version: 2 })]];
    const send = vi.fn();
    expect(await confirmAndResume(payment(), send)).toBe("needs_review");
    expect(updates[0]).toMatchObject({ status: "needs_refund" });
    expect(stamped()).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });
  it("does not duplicate the intervention when already handled", async () => {
    selects = [[{ state: "cancelled" }]];
    claimRows = [];
    await confirmAndResume(payment(), vi.fn());
    expect(inserts).toHaveLength(0);
    expect(stamped()).toBe(true);
  });
});

describe("amount verification", () => {
  it("ignores a mismatched amount, flags an intervention, never resumes", async () => {
    selects = [[{ state: "awaiting_payment" }], [quote()]];
    const send = vi.fn();
    expect(await confirmAndResume(payment({ amountCents: 100 }), send)).toBe("needs_review");
    expect(send).not.toHaveBeenCalled();
    expect(inserts[0]).toMatchObject({ jobId: "j1", kind: "refund" });
    expect(stamped()).toBe(true);
  });
  it("resumes when amount matches the quote", async () => {
    selects = [[{ state: "awaiting_payment" }], [quote()]];
    const send = vi.fn();
    expect(await confirmAndResume(payment(), send)).toBe("resumed");
    expect(send).toHaveBeenCalledOnce();
    expect(inserts).toHaveLength(0);
  });
  it("per_finding authorization must equal the cap", async () => {
    selects = [[{ state: "awaiting_payment" }], [quote({ pricingMode: "per_finding", capCents: 1500 })]];
    const send = vi.fn();
    expect(await confirmAndResume(payment({ status: "authorized", amountCents: 4900 }), send)).toBe("needs_review");
    expect(stripeMock.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("x402 (USDC) payments through confirmAndResume", () => {
  const x402 = (over: Partial<PaymentRow> = {}) =>
    payment({ currency: "usdc", stripePaymentIntentId: null, stripeCheckoutSessionId: `x402:eip155:84532:0x${"cd".repeat(32)}`, ...over });
  it("late x402 payment after cancel is marked needs_refund with a refund intervention, never resumed", async () => {
    selects = [[{ state: "cancelled" }]];
    const send = vi.fn();
    expect(await confirmAndResume(x402(), send)).toBe("needs_review");
    expect(updates[0]).toMatchObject({ status: "needs_refund" });
    expect(inserts[0]).toMatchObject({ jobId: "j1", kind: "refund" });
    expect(String(inserts[0]!.note)).toContain("49.00 USDC");
    expect(stripeMock.paymentIntents.cancel).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(stamped()).toBe(true);
  });
  it("a matching USDC amount resumes the job like a card payment", async () => {
    selects = [[{ state: "awaiting_payment" }], [quote()]];
    const send = vi.fn();
    expect(await confirmAndResume(x402(), send)).toBe("resumed");
    expect(send).toHaveBeenCalledWith("j1", { type: "payment_confirmed", paymentId: "p1", quoteVersion: 1 });
  });
  it("a short USDC amount is an amount_mismatch (needs_refund), never resumed", async () => {
    selects = [[{ state: "awaiting_payment" }], [quote()]];
    const send = vi.fn();
    expect(await confirmAndResume(x402({ amountCents: 4800 }), send)).toBe("needs_review");
    expect(updates[0]).toMatchObject({ status: "needs_refund" });
    expect(send).not.toHaveBeenCalled();
  });
});

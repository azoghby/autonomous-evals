import { describe, expect, it } from "vitest";
import {
  BRANCH_TTL_MS, CREDENTIALS_TTL_MS, MAX_CLARIFICATION_ROUNDS, budgetCheck, BUDGET_SHARE,
  decideAfterQualify, decidePayment, deliveryDeadlines, isQuoteAcceptance,
} from "./decisions";

const pay = (quoteVersion: number, paymentId = "11111111-1111-4111-8111-111111111111") =>
  ({ type: "payment_confirmed", paymentId, quoteVersion }) as const;

describe("decidePayment", () => {
  it("accepts a payment for the latest quote version", () => {
    expect(decidePayment(pay(2), 2, [])).toEqual({ action: "accept" });
  });
  it("ignores a payment for a stale quote version", () => {
    expect(decidePayment(pay(1), 2, [])).toEqual({ action: "ignore", reason: "quote_version_mismatch" });
  });
  it("ignores a duplicate payment id", () => {
    expect(decidePayment(pay(2), 2, [pay(2).paymentId])).toEqual({ action: "ignore", reason: "duplicate" });
  });
});

describe("isQuoteAcceptance", () => {
  it("only matches the latest quote version", () => {
    expect(isQuoteAcceptance({ type: "quote_accepted", quoteVersion: 3 }, 3)).toBe(true);
    expect(isQuoteAcceptance({ type: "quote_accepted", quoteVersion: 2 }, 3)).toBe(false);
    expect(isQuoteAcceptance({ type: "cancel", reason: "x" }, 3)).toBe(false);
  });
});

describe("decideAfterQualify", () => {
  it("quotes and declines immediately", () => {
    expect(decideAfterQualify("quote", 0)).toBe("quote");
    expect(decideAfterQualify("decline", 0)).toBe("decline");
  });
  it("asks until the round limit, then gives up", () => {
    expect(decideAfterQualify("clarify", MAX_CLARIFICATION_ROUNDS - 1)).toBe("ask");
    expect(decideAfterQualify("clarify", MAX_CLARIFICATION_ROUNDS)).toBe("give_up");
  });
});

describe("deliveryDeadlines", () => {
  it("sets independent 24h and 48h deadlines from delivery", () => {
    const at = new Date("2026-11-07T12:00:00Z");
    const d = deliveryDeadlines(at);
    expect(d.credentialsDeleteAfter.getTime() - at.getTime()).toBe(CREDENTIALS_TTL_MS);
    expect(d.branchDeleteAfter.getTime() - at.getTime()).toBe(BRANCH_TTL_MS);
  });
});

describe("budgetCheck", () => {
  const cap = 3_000_000;
  it("shares sum to one", () => {
    expect(Object.values(BUDGET_SHARE).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it("allows a stage within the remaining budget", () => {
    expect(budgetCheck(cap, 0, 0, "engineer")).toEqual({ ok: true, reserve: 750_000 });
  });
  it("pauses when the cap is exhausted", () => {
    expect(budgetCheck(cap, cap, 0, "commercial").ok).toBe(false);
    expect(budgetCheck(cap, 2_900_000, 0, "engineer").ok).toBe(false);
    expect(budgetCheck(cap, 1_000_000, 1_500_000, "investigator").ok).toBe(false);
  });
});

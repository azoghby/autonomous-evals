import { describe, expect, it } from "vitest";
import {
  BRANCH_TTL_MS, CREDENTIALS_TTL_MS, MAX_CLARIFICATION_ROUNDS, budgetCheck, BUDGET_SHARE,
  decideAfterQualify, decideCancel, decidePayment, deliveryDeadlines, isQuoteAcceptance,
  connectionFailureMessage, needsConnectionCheck, sanitizeCheckDetail, selectFindingsForFix,
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

describe("connection check helpers", () => {
  it("skips trace audit only", () => {
    expect(needsConnectionCheck("trace_audit")).toBe(false);
    expect(needsConnectionCheck("text_eval")).toBe(true);
    expect(needsConnectionCheck("workflow_eval")).toBe(true);
    expect(needsConnectionCheck("version_comparison")).toBe(true);
  });
  it("redacts the api key and bearer tokens and truncates", () => {
    const d = sanitizeCheckDetail("401 for Bearer abc.def-123 with key supersecretvalue1", ["supersecretvalue1"]);
    expect(d).not.toContain("supersecretvalue1");
    expect(d).not.toContain("abc.def-123");
    expect(sanitizeCheckDetail("x".repeat(1000)).length).toBeLessThan(400);
  });
  it("builds a customer message listing each failure", () => {
    const m = connectionFailureMessage([{ label: "Endpoint A", detail: "timeout" }]);
    expect(m).toContain("Endpoint A: timeout");
    expect(m).toContain("not issued a quote");
  });
});

describe("decideCancel", () => {
  const owner = { id: "u1", isOperator: false };
  const job = (state: any, customerId = "u1") => ({ customerId, state });
  it("lets owners cancel before planning", () => {
    for (const s of ["draft", "needs_clarification", "quoted", "awaiting_payment"]) {
      expect(decideCancel(job(s), owner)).toEqual({ allowed: true, asOperator: false });
    }
  });
  it("refuses owners once work started or finished", () => {
    for (const s of ["planning", "running", "investigating", "paused_budget"]) {
      expect(decideCancel(job(s), owner)).toMatchObject({ allowed: false, status: 409 });
    }
    expect(decideCancel(job("delivered"), owner)).toMatchObject({ allowed: false, status: 409 });
  });
  it("hides jobs from other non-operators", () => {
    expect(decideCancel(job("quoted", "other"), owner)).toMatchObject({ allowed: false, status: 404 });
  });
  it("lets operators cancel any non-terminal job as an intervention", () => {
    const op = { id: "op", isOperator: true };
    expect(decideCancel(job("running"), op)).toEqual({ allowed: true, asOperator: true });
    expect(decideCancel(job("cancelled"), op)).toMatchObject({ allowed: false, status: 409 });
  });
});

describe("selectFindingsForFix", () => {
  const f = (id: string, status: "confirmed" | "rubric_concern" | "inconclusive", severity: "critical" | "high" | "medium" | "low") => ({ id, status, severity });
  it("keeps only confirmed findings, deduped, most severe first", () => {
    const out = selectFindingsForFix([f("a", "confirmed", "low"), f("b", "inconclusive", "critical"), f("c", "confirmed", "critical"), f("a", "confirmed", "low")]);
    expect(out.map((x) => x.id)).toEqual(["c", "a"]);
  });
  it("caps at 5 by default and honors a custom max", () => {
    const many = Array.from({ length: 8 }, (_, i) => f(`f${i}`, "confirmed", "medium"));
    expect(selectFindingsForFix(many)).toHaveLength(5);
    expect(selectFindingsForFix(many, 2).map((x) => x.id)).toEqual(["f0", "f1"]);
    expect(selectFindingsForFix(many, 0)).toEqual([]);
  });
});

import { settlementMessage } from "./decisions";
describe("settlementMessage", () => {
  it("describes charges and the zero case", () => {
    expect(settlementMessage(2, 600)).toBe("Charged $6.00 for 2 confirmed findings.");
    expect(settlementMessage(1, 300)).toBe("Charged $3.00 for 1 confirmed finding.");
    expect(settlementMessage(0, 0)).toBe("No confirmed findings: authorization released, you pay $0.");
  });
});

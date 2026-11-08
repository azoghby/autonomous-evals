import { describe, expect, it } from "vitest";
import { JOB_STATES, type JobState } from "@ae/core/contracts/index";
import { decideResumePlan, findUnlockingPayment, isRestartablePlan, type ResumeSnapshot } from "./decisions";

const PAY = "22222222-2222-4222-8222-222222222222";
const quote = (over: Partial<NonNullable<ResumeSnapshot["latestQuote"]>> = {}) =>
  ({ version: 2, accepted: false, pricingMode: "fixed", priceCents: 4900, capCents: null, ...over });
const payment = (over: Partial<ResumeSnapshot["payments"][number]> = {}) =>
  ({ id: PAY, quoteVersion: 2, status: "paid", kind: "one_time", amountCents: 4900, currency: "usd", ...over });
const snap = (over: Partial<ResumeSnapshot> = {}): ResumeSnapshot => ({
  state: "draft", package: "trace_audit", reportStored: false, latestQuote: null, payments: [], clarificationAnswers: [],
  qualifyCount: 0, connectionCheckFailures: 0, receivedRecorded: false, findingsCount: 0, remediationsCount: 0, ...over,
});
const paid = (over: Partial<ResumeSnapshot> = {}) => snap({ latestQuote: quote({ accepted: true }), payments: [payment()], ...over });

describe("decideResumePlan: every JobState maps to a plan", () => {
  it.each(JOB_STATES.map((s) => [s]))("%s returns a known phase", (state) => {
    const plan = decideResumePlan(paid({ state: state as JobState }));
    expect(["finished", "hold", "qualify", "await_clarification", "await_quote_acceptance", "await_payment", "execute", "deliver"])
      .toContain(plan.phase);
  });
});

describe("decideResumePlan: terminal and held states", () => {
  it.each(["delivered", "cancelled", "failed"] as const)("%s exits as finished", (state) => {
    expect(decideResumePlan(paid({ state }))).toMatchObject({ phase: "finished" });
  });
  it.each(["paused_budget", "payment_review"] as const)("%s is held for an operator, even when paid", (state) => {
    const plan = decideResumePlan(paid({ state }));
    expect(plan.phase).toBe("hold");
    expect(isRestartablePlan(plan)).toBe(false);
  });
});

describe("decideResumePlan: scoping", () => {
  it("fresh draft qualifies with no history (unchanged first-run behaviour)", () => {
    expect(decideResumePlan(snap())).toEqual({ phase: "qualify", clarifications: [], clarifyRounds: 0, checkRounds: 0 });
  });
  it("needs_clarification without a pending answer waits, keeping prior answers and round counts", () => {
    const plan = decideResumePlan(snap({ state: "needs_clarification", qualifyCount: 2, clarificationAnswers: ["first"] }));
    expect(plan).toEqual({ phase: "await_clarification", clarifications: ["first"], clarifyRounds: 2, checkRounds: 0 });
  });
  it("needs_clarification with an answer saved while no run listened re-qualifies immediately", () => {
    const plan = decideResumePlan(snap({ state: "needs_clarification", qualifyCount: 1, clarificationAnswers: ["answer"] }));
    expect(plan).toEqual({ phase: "qualify", clarifications: ["answer"], clarifyRounds: 1, checkRounds: 0 });
  });
  it("connection-check failures count as check rounds, not clarification rounds", () => {
    const plan = decideResumePlan(snap({ state: "needs_clarification", qualifyCount: 3, connectionCheckFailures: 2, clarificationAnswers: ["a", "b"] }));
    expect(plan).toMatchObject({ phase: "await_clarification", clarifyRounds: 1, checkRounds: 2 });
  });
  it("never yields negative rounds from inconsistent counts", () => {
    const plan = decideResumePlan(snap({ state: "needs_clarification", qualifyCount: 0, connectionCheckFailures: 3 }));
    expect(plan).toMatchObject({ phase: "qualify", clarifyRounds: 0, checkRounds: 3 });
  });
  it("quoted without a quote row re-qualifies", () => {
    expect(decideResumePlan(snap({ state: "quoted" }))).toMatchObject({ phase: "qualify" });
  });
});

describe("decideResumePlan: quote and payment", () => {
  it("quoted, not accepted: waits for quote_accepted of the latest version", () => {
    expect(decideResumePlan(snap({ state: "quoted", latestQuote: quote() }))).toEqual({ phase: "await_quote_acceptance", quoteVersion: 2 });
  });
  it("quoted, accepted in the DB (event lost): goes to payment", () => {
    expect(decideResumePlan(snap({ state: "quoted", latestQuote: quote({ accepted: true }) }))).toEqual({ phase: "await_payment", quoteVersion: 2 });
  });
  it("quoted or awaiting_payment with a valid payment: executes and announces the payment", () => {
    for (const state of ["quoted", "awaiting_payment"] as const) {
      expect(decideResumePlan(paid({ state }))).toEqual({ phase: "execute", quoteVersion: 2, paymentId: PAY, announcePayment: true, discardPartialResults: false });
    }
  });
  it("awaiting_payment without payment waits; without a quote is held", () => {
    expect(decideResumePlan(snap({ state: "awaiting_payment", latestQuote: quote({ accepted: true }) }))).toEqual({ phase: "await_payment", quoteVersion: 2 });
    expect(decideResumePlan(snap({ state: "awaiting_payment" }))).toMatchObject({ phase: "hold" });
  });
  it("awaiting_payment ignores payments that cannot unlock the latest quote", () => {
    const bad = [
      payment({ quoteVersion: 1 }), payment({ status: "needs_refund" }), payment({ status: "released" }),
      payment({ amountCents: 100 }), payment({ currency: "eur" }), payment({ kind: "subscription" }),
    ];
    expect(decideResumePlan(snap({ state: "awaiting_payment", latestQuote: quote({ accepted: true }), payments: bad })))
      .toEqual({ phase: "await_payment", quoteVersion: 2 });
  });
});

describe("decideResumePlan: working states", () => {
  it.each(["planning", "running", "investigating"] as const)("%s with payment and no report re-executes without re-announcing payment", (state) => {
    expect(decideResumePlan(paid({ state }))).toEqual({ phase: "execute", quoteVersion: 2, paymentId: PAY, announcePayment: false, discardPartialResults: false });
  });
  it("discards partial findings/remediations left by the dead run", () => {
    expect(decideResumePlan(paid({ state: "investigating", findingsCount: 3 }))).toMatchObject({ phase: "execute", discardPartialResults: true });
    expect(decideResumePlan(paid({ state: "running", remediationsCount: 1 }))).toMatchObject({ phase: "execute", discardPartialResults: true });
  });
  it("report already stored: skips evaluation and only delivers", () => {
    expect(decideResumePlan(paid({ state: "investigating", reportStored: true, findingsCount: 4 }))).toEqual({ phase: "deliver" });
  });
  it.each(["planning", "running", "investigating"] as const)("%s without a valid payment is held (inconsistent)", (state) => {
    expect(decideResumePlan(snap({ state, latestQuote: quote({ accepted: true }) }))).toMatchObject({ phase: "hold" });
    expect(decideResumePlan(snap({ state }))).toMatchObject({ phase: "hold" });
  });
});

describe("findUnlockingPayment", () => {
  it("accepts per_finding authorizations at the cap amount", () => {
    const q = quote({ pricingMode: "per_finding", capCents: 1500 });
    expect(findUnlockingPayment([payment({ status: "authorized", amountCents: 1500 })], q)).toEqual({ id: PAY });
    expect(findUnlockingPayment([payment({ status: "authorized", amountCents: 4900 })], q)).toBeNull();
  });
  it("picks the first valid payment among several", () => {
    const other = "33333333-3333-4333-8333-333333333333";
    expect(findUnlockingPayment([payment({ quoteVersion: 1 }), payment({ id: other })], quote())).toEqual({ id: other });
  });
});

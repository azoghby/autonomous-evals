import type { JobEvent, Package } from "@ae/core/contracts/index";

/** Pure decision logic for jobWorkflow, kept free of I/O so it is unit-testable. */

export const MAX_CLARIFICATION_ROUNDS = 3;
export const CREDENTIALS_TTL_MS = 24 * 3600_000;
export const BRANCH_TTL_MS = 48 * 3600_000;

export type PaymentDecision =
  | { action: "accept" }
  | { action: "ignore"; reason: "quote_version_mismatch" | "duplicate" };

type PaymentEvent = Extract<JobEvent, { type: "payment_confirmed" }>;

/** A payment unlocks the job only if it is for the latest quote and not a replay of one already seen. */
export function decidePayment(event: PaymentEvent, latestQuoteVersion: number, seenPaymentIds: readonly string[]): PaymentDecision {
  if (seenPaymentIds.includes(event.paymentId)) return { action: "ignore", reason: "duplicate" };
  if (event.quoteVersion !== latestQuoteVersion) return { action: "ignore", reason: "quote_version_mismatch" };
  return { action: "accept" };
}

export function isQuoteAcceptance(event: JobEvent, latestQuoteVersion: number): boolean {
  return event.type === "quote_accepted" && event.quoteVersion === latestQuoteVersion;
}

export type ClarifyDecision = "quote" | "ask" | "decline" | "give_up";

/** Maps a Commercial qualify decision plus rounds already used to the workflow's next move. */
export function decideAfterQualify(decision: "quote" | "clarify" | "decline", roundsUsed: number): ClarifyDecision {
  if (decision === "quote") return "quote";
  if (decision === "decline") return "decline";
  return roundsUsed >= MAX_CLARIFICATION_ROUNDS ? "give_up" : "ask";
}

export const isTracePackage = (pkg: Package) => pkg === "trace_audit";

/** Credential and branch deletion deadlines are independent, both anchored at delivery. */
export function deliveryDeadlines(deliveredAt: Date) {
  return {
    deliveredAt,
    credentialsDeleteAfter: new Date(deliveredAt.getTime() + CREDENTIALS_TTL_MS),
    branchDeleteAfter: new Date(deliveredAt.getTime() + BRANCH_TTL_MS),
  };
}

export type BudgetAgent = "commercial" | "engineer" | "investigator" | "operator" | "judge";

/** Share of the per-job cap reserved before each agent-calling step. Shares sum to 1. */
export const BUDGET_SHARE: Record<BudgetAgent, number> = {
  commercial: 0.1, engineer: 0.25, judge: 0.25, investigator: 0.25, operator: 0.15,
};

export function budgetCheck(cap: number, spent: number, otherReserved: number, agent: BudgetAgent):
  { ok: true; reserve: number } | { ok: false; reserve: number; available: number } {
  const reserve = Math.floor(cap * BUDGET_SHARE[agent]);
  const available = cap - spent - otherReserved;
  return available >= reserve && spent < cap ? { ok: true, reserve } : { ok: false, reserve, available };
}

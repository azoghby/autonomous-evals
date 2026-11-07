import type { JobEvent, JobState, Package } from "@ae/core/contracts/index";

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

/** Connection pre-check applies to every package that runs against a customer endpoint. */
export const needsConnectionCheck = (pkg: Package) => pkg !== "trace_audit";
export const MAX_CONNECTION_CHECK_ROUNDS = 5;
const MAX_DETAIL_CHARS = 300;

/** Strips credentials from a connection-check detail before it reaches the customer. */
export function sanitizeCheckDetail(detail: string, secrets: readonly string[] = []): string {
  let out = detail;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("[redacted]");
  out = out
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b(sk|pk|rk|key|tok|token)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/\b(api[-_ ]?key|authorization|x-api-key)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .replace(/\s+/g, " ").trim();
  return out.length > MAX_DETAIL_CHARS ? `${out.slice(0, MAX_DETAIL_CHARS)}...` : out;
}

export interface EndpointCheckFailure { label: string; detail: string }

/** Customer-facing message asking them to fix unreachable endpoints. Contains no secrets. */
export function connectionFailureMessage(failures: readonly EndpointCheckFailure[]): string {
  const lines = failures.map((f) => `- ${f.label}: ${f.detail || "connection failed"}`);
  return [
    "We could not reach your endpoint with the details provided, so we have not issued a quote yet.",
    ...lines,
    "Please check the URL, model name and API key, make sure the endpoint is publicly reachable over HTTPS, then reply here once it is fixed and we will test the connection again.",
  ].join("\n");
}

const CANCEL_BEFORE_PLANNING: readonly JobState[] = ["draft", "needs_clarification", "quoted", "awaiting_payment"];
const TERMINAL_STATES: readonly JobState[] = ["cancelled", "failed", "delivered"];

export type CancelDecision =
  | { allowed: true; asOperator: boolean }
  | { allowed: false; status: 403 | 404 | 409; error: string };

/** Owners may cancel only before planning starts; operators may cancel any non-terminal job. */
export function decideCancel(job: { customerId: string; state: JobState }, viewer: { id: string; isOperator: boolean }): CancelDecision {
  const isOwner = job.customerId === viewer.id;
  if (!isOwner && !viewer.isOperator) return { allowed: false, status: 404, error: "Job not found" };
  if (TERMINAL_STATES.includes(job.state)) return { allowed: false, status: 409, error: "Job is already finished" };
  if (viewer.isOperator && !isOwner) return { allowed: true, asOperator: true };
  if (!CANCEL_BEFORE_PLANNING.includes(job.state)) {
    return { allowed: false, status: 409, error: "Work has already started and can no longer be cancelled here; contact support" };
  }
  return { allowed: true, asOperator: viewer.isOperator };
}

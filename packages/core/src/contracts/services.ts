/**
 * Service signatures Track B implements and Track A's workflow calls.
 * Services return validated data; the workflow decides sequencing.
 */
import type { Finding, IntakeInput, QualifyResult, Remediation, Report, Scenario, Suite, CostEntry } from "./index";

export interface ServiceContext {
  jobId: string;
  environment: "live" | "test";
  /** Remaining reserved budget for this job in micro-USD. */
  budgetMicroUsd: number;
  recordCost(entry: Omit<CostEntry, "jobId">): Promise<void>;
  recordProgress(milestone: string, message: string): Promise<void>;
  /** Optional shared adapters (additive). Provided by Track A's app; absent in bare unit-test contexts. */
  sessions?: AgentSessionStore;
  budget?: BudgetReserver;
  artifacts?: ArtifactStore;
}

export const TERMINAL_SESSION_STATUSES = ["completed", "failed", "cancelled"] as const;
export type TerminalSessionStatus = (typeof TERMINAL_SESSION_STATUSES)[number];

export interface AgentSessionRecord {
  id: string;
  jobId: string | null;
  agent: string;
  agentId: string | null;
  agentVersion: string | null;
  sessionId: string | null;
  status: string;
  decision: string | null;
  result: unknown;
  usageMicroUsd: number;
}

/** Persists Naive agent sessions (table agent_sessions) scoped to the ctx job so a redeployed step can resume. Never store secrets in `result`. */
export interface AgentSessionStore {
  /** Idempotent on sessionId: a repeat call returns the existing row instead of inserting. */
  start(input: { agent: string; agentId?: string; agentVersion?: string; sessionId: string }): Promise<AgentSessionRecord>;
  /** Single UPDATE; addUsageMicroUsd (non-negative integer) is incremented atomically in SQL. Returns the row, or null if unknown for this job. */
  update(sessionId: string, patch: { status?: string; decision?: string; result?: unknown; addUsageMicroUsd?: number }): Promise<AgentSessionRecord | null>;
  /** Latest non-terminal (not completed/failed/cancelled) session for this job and agent, or null. */
  findResumable(agent: string): Promise<AgentSessionRecord | null>;
}

export type ReserveResult = { ok: true; reservationId: string } | { ok: false; remainingMicroUsd: number };

/** Atomic per-job budget reservations (table budget_reservations). Prefer the workflow's withBudget for whole stages; use this for extra spend inside a stage. */
export interface BudgetReserver {
  /** Reserves only if (job cap - unreleased reservations - recorded costs) >= microUsd, in one SQL statement. microUsd must be a positive integer. */
  reserve(agent: string, microUsd: number): Promise<ReserveResult>;
  /** Idempotent: releasing an already-released or unknown reservation is a no-op. */
  release(reservationId: string): Promise<void>;
}

/** Job-scoped artifact storage over the shared storage facade (Neon default, Blob fallback). */
export interface ArtifactStore {
  /** `name` must match /^[a-z0-9][a-z0-9._-]{0,99}$/ and not contain "..". Returns a prefixed pathname (persist the pathname, never a URL). */
  put(name: string, body: string | Uint8Array, contentType: string): Promise<{ pathname: string }>;
  /** Reads a pathname produced by put for THIS job; null when missing. Throws for other jobs' paths. */
  get(pathname: string): Promise<{ body: Uint8Array; contentType: string } | null>;
}

export interface TraceAuditResult { findings: Finding[]; claimsChecked: number }
export interface RunCheckAssessment {
  checkId: string;
  kind: "objective" | "rubric";
  status: "pass" | "fail" | "concern" | "inconclusive" | "not_assessed" | "error";
  detail: string;
  evidenceQuotes: string[];
  reason: "target_error" | "judge_unavailable" | "judge_not_configured" | "no_reference" | "judge_inconclusive" | "check_error" | null;
}
export interface RunAssessment {
  kind: "objective" | "rubric" | "inconclusive" | "infrastructure";
  outcome: "completed" | "infrastructure_error";
  checks: RunCheckAssessment[];
}
type ScenarioResultBase = { scenarioId: string; detail: string };
/** Legacy booleans remain readable. Rich subjective and unavailable results never carry a boolean. */
export type RunScenarioResult = ScenarioResultBase & (
  | { passed: boolean; assessment?: undefined }
  | { passed: boolean; assessment: RunAssessment & { kind: "objective" } }
  | { passed?: never; assessment: RunAssessment & { kind: "rubric" | "inconclusive" | "infrastructure" } }
);
export interface RunResult { runId: string; versionLabel: string; results: RunScenarioResult[] }
/** Only complete objective evidence (or a legacy boolean) participates in binary scoring. */
export function objectivePassed(result: { passed?: boolean; assessment?: RunAssessment }): boolean | undefined {
  if (!result.assessment) return result.passed;
  const a = result.assessment;
  if (a.kind !== "objective" || a.outcome !== "completed" || !a.checks.length || a.checks.some(c => c.kind !== "objective" || (c.status !== "pass" && c.status !== "fail"))) return undefined;
  return a.checks.every(c => c.status === "pass");
}
export function summarizeRunResults(results: readonly RunScenarioResult[]) {
  const counts = { passed: 0, failed: 0, rubric: 0, inconclusive: 0, infrastructure: 0 };
  for (const result of results) {
    const passed = objectivePassed(result);
    if (passed !== undefined) counts[passed ? "passed" : "failed"]++;
    else if (result.assessment?.kind === "rubric") counts.rubric++;
    else if (result.assessment?.kind === "infrastructure") counts.infrastructure++;
    else counts.inconclusive++;
  }
  return counts;
}

export interface EvalServices {
  qualify(ctx: ServiceContext, intake: IntakeInput, clarifications: string[]): Promise<QualifyResult>;
  auditTrace(ctx: ServiceContext, trace: string, systemPrompt?: string): Promise<TraceAuditResult>;
  checkTarget(ctx: ServiceContext, endpoint: { url: string; model: string; apiKey?: string }): Promise<{ ok: boolean; detail: string }>;
  designSuite(ctx: ServiceContext, intake: IntakeInput): Promise<Suite>;
  runSuite(ctx: ServiceContext, suite: Suite, target: { url: string; model: string; apiKey?: string; systemPrompt: string }, branchConnString?: string): Promise<RunResult>;
  investigate(ctx: ServiceContext, suite: Suite, runs: RunResult[]): Promise<Finding[]>;
  renderReport(ctx: ServiceContext, input: { intake: IntakeInput; findings: Finding[]; suite?: Suite; remediations?: Remediation[] }): Promise<Report>;
  createJobBranch(jobId: string): Promise<{ branchId: string; connectionString: string }>;
  deleteJobBranch(branchId: string): Promise<void>;
  /** Resolves a branch's connection string (a secret) from its id. Call only inside steps; never persist or return it from a step. */
  getJobBranchConnection?(branchId: string): Promise<string>;
  /** Proposes a concrete fix for a confirmed finding and verifies it by re-running the relevant frozen scenario(s) / trace re-check with the patch applied. */
  proposeAndVerifyFix(ctx: ServiceContext, input: { finding: Finding; suite?: Suite; intake: IntakeInput }): Promise<Remediation>;
  rerunFinding(ctx: ServiceContext, finding: Finding, scenario: Scenario | undefined): Promise<Finding>;
}

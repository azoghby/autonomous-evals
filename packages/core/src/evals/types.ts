/**
 * Track B service contracts and dependency-injected ports.
 *
 * PROVISIONAL: these types live here until Track A creates packages/core/src/contracts/**.
 * When that happens, move the Zod schemas there and re-export them from this file so callers
 * do not break. Nothing here talks to a database directly: Track A implements the ports
 * (AgentTaskStore, BudgetLedger, ...) against Neon and passes them in.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Money. Integer micro-USD everywhere (matches the Naïve API). Never floats on the wire.
// ---------------------------------------------------------------------------

export const MicroUsdSchema = z.number().int().nonnegative();
export type MicroUsd = number;
export const MICRO_USD_PER_USD = 1_000_000;
export const usd = (dollars: number): MicroUsd => Math.round(dollars * MICRO_USD_PER_USD);
export const formatUsd = (micro: MicroUsd): string => `$${(micro / MICRO_USD_PER_USD).toFixed(2)}`;

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const PackageIdSchema = z.enum([
  "trace_audit",
  "text_eval",
  "workflow_eval",
  "version_comparison",
  "monitoring_pilot",
]);
export type PackageId = z.infer<typeof PackageIdSchema>;

export const EnvironmentSchema = z.enum(["live", "test"]);
export type Environment = z.infer<typeof EnvironmentSchema>;

/** Safe identifier: used inside task keys, idempotency keys and metadata. */
export const SafeIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9_-]+$/, "only letters, digits, '_' and '-'");

export const JobRefSchema = z.object({
  jobId: SafeIdSchema,
  customerId: z.string().min(1).max(128),
  package: PackageIdSchema,
  environment: EnvironmentSchema,
  quoteVersion: z.number().int().positive().nullable().default(null),
  linkedRetestOf: SafeIdSchema.nullable().default(null),
  /** Internal fixture jobs (buggy/fixed demo agents). Never counted as customers or revenue. */
  isFixture: z.boolean().default(false),
});
export type JobRef = z.infer<typeof JobRefSchema>;
export type JobRefInput = z.input<typeof JobRefSchema>;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const AgentRoleSchema = z.enum([
  "commercial",
  "evaluation_engineer",
  "quality_investigator",
  "company_operator",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/** Naïve agent IDs per role, provisioned once (see agents/provision.ts) and kept in config/DB. */
export type AgentDirectory = Record<AgentRole, { agentId: string; agentVersion?: number | undefined }>;

// ---------------------------------------------------------------------------
// Cost records. Known costs only; unknown costs are labeled, never estimated.
// ---------------------------------------------------------------------------

export const CostEntrySchema = z.object({
  jobId: SafeIdSchema,
  source: z.enum(["naive_session"]),
  role: AgentRoleSchema.nullable(),
  /** Naïve session ID or gateway generation ID. */
  externalId: z.string().nullable(),
  purpose: z.string(),
  microUsd: MicroUsdSchema,
  /** True when the amount came from the provider's own usage report. */
  measured: z.boolean(),
  recordedAt: z.string(),
});
export type CostEntry = z.infer<typeof CostEntrySchema>;

// ---------------------------------------------------------------------------
// Durable agent-task records (one row per Naïve session we intend to create).
// Track A: table `agent_tasks`, primary key `task_key`, integer `revision` for CAS.
// ---------------------------------------------------------------------------

export const AgentTaskStateSchema = z.enum([
  /** Row written, budget reserved, create call may or may not have been sent. */
  "creating",
  /** Create outcome unknown (timeout/5xx/unreadable 2xx). Must be recovered, never re-created with a new key. */
  "ambiguous",
  /** Session ID persisted. Waiting for it to finish. */
  "created",
  "completed",
  "schema_failed",
  "budget_paused",
  "failed",
  /** A human has to look (duplicate sessions found, session asked a question, recovery exhausted). */
  "needs_operator",
]);
export type AgentTaskState = z.infer<typeof AgentTaskStateSchema>;

export interface AgentTaskRecord {
  taskKey: string;
  revision: number;
  jobId: string;
  role: AgentRole;
  purpose: string;
  attempt: number;
  agentId: string;
  state: AgentTaskState;
  /** Deterministic; reused byte-for-byte on any replay. Never regenerated. */
  idempotencyKey: string;
  /** The exact create body (already redacted). Replays must send this, not a rebuilt one. */
  requestBody: NaiveSessionCreateBody;
  reservationId: string;
  budgetMicroUsd: MicroUsd;
  sessionId: string | null;
  agentVersion: number | null;
  consumedMicroUsd: MicroUsd | null;
  tokenUsage: Record<string, number> | null;
  /** Validated structured output (only when state = completed). */
  result: unknown;
  error: { code: string; message: string } | null;
  replayCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AgentTaskPatch = Partial<Omit<AgentTaskRecord, "taskKey" | "revision" | "createdAt">>;

export interface AgentTaskStore {
  get(taskKey: string): Promise<AgentTaskRecord | null>;
  /** INSERT ... ON CONFLICT (task_key) DO NOTHING, then return the stored row. */
  insertIfAbsent(record: AgentTaskRecord): Promise<{ inserted: boolean; record: AgentTaskRecord }>;
  /**
   * UPDATE ... SET ..., revision = revision + 1 WHERE task_key = $1 AND revision = $2.
   * Returns the new row, or null when another writer got there first.
   */
  compareAndSet(taskKey: string, expectedRevision: number, patch: AgentTaskPatch): Promise<AgentTaskRecord | null>;
}

// ---------------------------------------------------------------------------
// Budget ledger. Reservations are atomic across every scope they touch.
// ---------------------------------------------------------------------------

export interface BudgetScope {
  /** e.g. `agent:commercial:2026-11-hackathon`, `job:<jobId>` */
  key: string;
  capMicroUsd: MicroUsd;
}

export interface BudgetReservationRequest {
  /** Idempotent: reserving the same ID twice is a no-op that returns the first result. */
  reservationId: string;
  jobId: string;
  amountMicroUsd: MicroUsd;
  scopes: BudgetScope[];
}

export type BudgetReservationResult =
  | { ok: true; reservationId: string; replayed: boolean }
  | { ok: false; reservationId: string; exhaustedScope: string; capMicroUsd: MicroUsd; availableMicroUsd: MicroUsd };

export interface BudgetLedger {
  /**
   * All-or-nothing: every scope must have `cap - (reserved + settled) >= amount`, checked and
   * written in one transaction (see docs/track-b-agents.md for the reference SQL).
   */
  reserve(request: BudgetReservationRequest): Promise<BudgetReservationResult>;
  /**
   * Replace the reservation with what was actually spent, releasing the remainder.
   * Idempotent: settling an already-settled reservation returns the first settlement.
   * Spend above the reservation is recorded as-is (overage), never silently capped.
   */
  settle(reservationId: string, consumedMicroUsd: MicroUsd): Promise<{ settledMicroUsd: MicroUsd; replayed: boolean }>;
}

// ---------------------------------------------------------------------------
// Naïve session port (implemented by agents/naive-adapter.ts over the real SDK).
// ---------------------------------------------------------------------------

export interface NaiveSessionCreateBody {
  agent_id: string;
  message: string;
  agent_version?: number;
  /** Exact provisioned advisory outcome ID; never an authorization or grading gate. */
  outcome?: string;
  budget_micro_usd: number;
  output_schema: Record<string, unknown>;
  structured_output_required: true;
  metadata: Record<string, string | number | boolean>;
  window?: "immediate" | "priority" | "loose";
}

export type NaiveSessionStatus = "queued" | "running" | "idle" | "completed" | "failed" | "cancelled";

export interface NaiveSessionSnapshot {
  id: string;
  agentId: string;
  agentVersion: number;
  status: NaiveSessionStatus;
  stopReason: string | null;
  stopCode: string | null;
  structuredOutput: Record<string, unknown> | null;
  budgetMicroUsd: number;
  consumedMicroUsd: number;
  tokenUsage: Record<string, number>;
  metadata: Record<string, unknown>;
}

/**
 * How a failed Naïve call should be treated.
 * - definitive: the server answered non-2xx; nothing was created and the idempotency key was released.
 * - rate_limited: 429; nothing was created; safe to retry later with the same key.
 * - in_flight: 409 idempotency_conflict; the first request with this key is still running.
 * - ambiguous: timeout, network failure, 5xx from an intermediary, or an unreadable 2xx.
 */
export type NaiveErrorKind = "definitive" | "rate_limited" | "in_flight" | "ambiguous";

export class NaiveCallError extends Error {
  constructor(
    readonly kind: NaiveErrorKind,
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = "NaiveCallError";
  }
}

export interface NaiveSessionsPort {
  createSession(body: NaiveSessionCreateBody, idempotencyKey: string): Promise<NaiveSessionSnapshot>;
  getSession(sessionId: string): Promise<NaiveSessionSnapshot>;
  listAgentSessions(
    agentId: string,
    page: { after?: string | undefined; limit: number },
  ): Promise<{ data: NaiveSessionSnapshot[]; nextCursor: string | null }>;
}

// ---------------------------------------------------------------------------
// Other ports
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Every call site passes data through agents/redact.ts first; implementations may add their own scrubbing. */
export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}
export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/**
 * Rubric judge. Structurally identical to the function returned by `createGatewayJudge` in
 * packages/core/src/judges/gateway.ts (owned outside Track B); pass that function directly.
 * It throws (JudgeUnavailableError) on malformed/unverifiable output; callers map a throw to
 * "inconclusive", never to pass or fail. Its usage is recorded by the judge itself (token counts
 * only; monetary cost stays unknown).
 */
export interface RubricJudgeInput {
  operationId: string;
  rubric: string;
  response: string;
  reference?: string;
  assessesFactualCorrectness?: boolean;
}
export interface RubricJudgeVerdict {
  outcome: "passed" | "rubric_concern" | "inconclusive";
  explanation: string;
  evidenceQuotes: string[];
}
export type RubricJudge = (input: RubricJudgeInput) => Promise<RubricJudgeVerdict>;

/**
 * Consumer-side view of the customer target. The secure HTTP client (HTTPS only, DNS/private-IP
 * checks, no redirects, timeouts, bounded body, credential redaction) is owned by targets/** and
 * must be what implements this port. Eval code never sees credentials.
 */
export interface TextTargetPort {
  send(request: { scenarioId: string; runId: string; systemPrompt: string | null; userMessage: string }): Promise<
    { ok: true; text: string; latencyMs: number } | { ok: false; errorCode: string; message: string; latencyMs: number }
  >;
}

// ---------------------------------------------------------------------------
// Findings (shared by Trace Audit and Text Eval; consumed by reporting).
// ---------------------------------------------------------------------------

export const FindingLabelSchema = z.enum(["confirmed", "rubric_concern", "inconclusive"]);
export type FindingLabel = z.infer<typeof FindingLabelSchema>;

export const SeveritySchema = z.enum(["high", "medium", "low"]);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * objective = code/state check; heuristic = code pattern match; agent = investigator-only; judge = rubric model;
 * unspecified = imported from a contract shape that does not carry the basis.
 */
export const FindingBasisSchema = z.enum(["objective", "heuristic", "agent", "judge", "unspecified"]);
export type FindingBasis = z.infer<typeof FindingBasisSchema>;

export const EvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("legacy_excerpt"), location: z.string(), quote: z.string(), truncated: z.literal(true) }),
  z.object({ kind: z.literal("trace_event"), eventId: z.string(), quote: z.string(), truncated: z.boolean() }),
  z.object({
    kind: z.literal("scenario_response"),
    scenarioId: z.string(),
    runId: z.string(),
    quote: z.string(),
    truncated: z.boolean(),
  }),
  z.object({ kind: z.literal("check"), checkId: z.string(), detail: z.string() }),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  source: z.enum(["trace_audit", "text_eval", "workflow_eval"]),
  category: z.string(),
  title: z.string(),
  label: FindingLabelSchema,
  severity: SeveritySchema,
  basis: FindingBasisSchema,
  summary: z.string(),
  evidence: z.array(EvidenceSchema).min(1),
  investigatorNote: z.string().nullable(),
  reproduction: z
    .object({ attempted: z.boolean(), reproduced: z.boolean().nullable(), runId: z.string().nullable() })
    .nullable(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Recorded whenever an investigator dismisses an objective check. Never silent. */
export const TestDefectRecordSchema = z.object({
  candidateId: z.string(),
  category: z.string(),
  note: z.string(),
  recordedBy: z.literal("quality_investigator"),
});
export type TestDefectRecord = z.infer<typeof TestDefectRecordSchema>;

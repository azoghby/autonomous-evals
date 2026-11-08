/**
 * Runs one Naïve agent task durably and returns a validated, typed outcome.
 *
 * Callable from a Vercel Workflow step: every call is re-entrant. Calling again with the same
 * job/role/purpose/attempt resumes the same task instead of starting a new session.
 *
 * Order of operations for a fresh task:
 *   1. refuse if the prompt contains a credential (nothing reserved, nothing sent)
 *   2. reserve budget atomically across the role-period scope and the job scope
 *   3. persist the intent row (state = creating, exact request body, deterministic idempotency key, lease)
 *   4. call sessions.create with that key; persist the session ID immediately
 *   5. poll; validate structured output with Zod; settle the reservation with measured usage
 *
 * Ambiguous creation (timeout, 5xx, unreadable 2xx, crash before the ID was saved) is never
 * retried with a new key. Recovery first looks the session up by `metadata.ae_task_key`; if not
 * found it may replay the *stored* body with the *stored* key a bounded number of times (the API
 * deduplicates replays), and then escalates to an operator. Schema failures and budget pauses are
 * never retried automatically.
 */
import { z } from "zod";
import { PRICE_TABLE } from "../evals/pricing";
import {
  type AgentDirectory,
  type AgentRole,
  type AgentTaskPatch,
  type AgentTaskRecord,
  type AgentTaskStore,
  type BudgetLedger,
  type Clock,
  type CostEntry,
  type JobRef,
  type Logger,
  type MicroUsd,
  NaiveCallError,
  type NaiveSessionCreateBody,
  type NaiveSessionSnapshot,
  type NaiveSessionsPort,
  SafeIdSchema,
  silentLogger,
  systemClock,
} from "../evals/types";
import { containsSecret, redactingLogger } from "./redact";
import { ROLE_DEFINITIONS } from "./roles";

export interface AgentTaskSpec<T> {
  job: Pick<JobRef, "jobId" | "environment" | "isFixture" | "package">;
  role: AgentRole;
  /** Stable name of the task within the job, e.g. `trace_recheck`. */
  purpose: string;
  /** Bump only when deliberately starting a new attempt (e.g. an operator-approved retry). */
  attempt?: number;
  message: string;
  output: { name: string; schema: z.ZodType<T> };
  budgetMicroUsd: MicroUsd;
  /** Secrets the caller knows about (decrypted target keys etc.). The task is refused if any appear. */
  knownSecrets?: readonly string[];
  /** Defaults to the package's per-job cap from the price table. */
  jobCapMicroUsd?: MicroUsd;
}

export interface SessionInfo {
  sessionId: string;
  agentId: string;
  agentVersion: number;
  consumedMicroUsd: MicroUsd;
  tokenUsage: Record<string, number>;
}

export type AgentTaskOutcome<T> =
  | { status: "completed"; taskKey: string; output: T; session: SessionInfo; cost: CostEntry }
  | {
      status: "pending";
      taskKey: string;
      reason: "session_running" | "create_in_progress_elsewhere" | "rate_limited" | "recovering" | "naive_unreachable";
      sessionId: string | null;
      retryAfterMs: number;
    }
  | { status: "budget_exhausted"; taskKey: string; exhaustedScope: string; capMicroUsd: MicroUsd; availableMicroUsd: MicroUsd }
  | { status: "budget_paused"; taskKey: string; session: SessionInfo; cost: CostEntry }
  | { status: "schema_failed"; taskKey: string; session: SessionInfo; cost: CostEntry; issues: string[] }
  | { status: "failed"; taskKey: string; code: string; message: string; session: SessionInfo | null; cost: CostEntry | null }
  | { status: "needs_operator"; taskKey: string; code: string; message: string; sessionIds: string[]; cost?: CostEntry | null };

export interface AgentSessionServiceDeps {
  naive: NaiveSessionsPort;
  store: AgentTaskStore;
  ledger: BudgetLedger;
  directory: AgentDirectory;
  /** Budget period label for role caps, e.g. `2026-11-hackathon`. */
  budgetPeriodId: string;
  /** Separates idempotency keys per deployment/org use, e.g. `prod`, `test`. Keys never expire server-side. */
  idempotencyNamespace: string;
  /** Unique per process/step invocation; used for create leases. */
  workerId: string;
  clock?: Clock;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  /** How long one call may wait for the session to finish before returning `pending`. Default 60 s. */
  maxWaitMs?: number;
  pollIntervalMs?: number;
  /** How long a create lease protects an in-flight create from other workers. Default 120 s. */
  leaseMs?: number;
  /** Same-key replays allowed after an ambiguous create. Default 2. Rate-limit retries do not count. */
  maxReplays?: number;
  recoveryScanPages?: number;
  recoveryPageSize?: number;
}

export const taskKeyFor = (jobId: string, role: AgentRole, purpose: string, attempt: number) =>
  `${jobId}:${role}:${purpose}:${attempt}`;

async function sha256Hex(input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function outputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** Object key order is not identity (notably after a jsonb round trip). Arrays stay ordered. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `required` is a set at schema nodes; defaults, examples and tuple arrays remain exact. */
function stableSchema(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const schema = { ...(value as Record<string, unknown>) };
  for (const [key, child] of Object.entries(schema)) {
    if (key === "required" && Array.isArray(child) && child.every((v) => typeof v === "string")) {
      schema[key] = [...child].sort();
    } else if (["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key) && child && typeof child === "object" && !Array.isArray(child)) {
      schema[key] = Object.fromEntries(Object.entries(child).map(([name, sub]) => [name, stableSchema(sub)]));
    } else if (["allOf", "anyOf", "oneOf", "prefixItems"].includes(key) && Array.isArray(child)) {
      schema[key] = child.map(stableSchema);
    } else if (["items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems"].includes(key)) {
      schema[key] = stableSchema(child);
    }
  }
  return schema;
}

const zodIssues = (error: z.ZodError): string[] =>
  error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

export class AgentSessionService {
  private readonly directory: AgentDirectory;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly maxReplays: number;
  private readonly scanPages: number;
  private readonly pageSize: number;

  constructor(private readonly deps: AgentSessionServiceDeps) {
    SafeIdSchema.parse(deps.idempotencyNamespace);
    // Detach before the first await: caller mutation must not replace a verified pin.
    // Missing pins remain supported for legacy callers; supplied pins must be exact.
    this.directory = structuredClone(deps.directory);
    for (const role of Object.keys(ROLE_DEFINITIONS) as AgentRole[]) {
      const agent = this.directory[role];
      if (!agent || typeof agent.agentId !== "string" || !agent.agentId.trim()) {
        throw new Error(`missing agent ID for ${role}`);
      }
      if (agent.agentVersion !== undefined &&
          (!Number.isSafeInteger(agent.agentVersion) || agent.agentVersion <= 0)) {
        throw new Error(`invalid agent version for ${role}`);
      }
      Object.freeze(agent);
    }
    Object.freeze(this.directory);
    this.clock = deps.clock ?? systemClock;
    this.log = redactingLogger(deps.logger ?? silentLogger);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxWaitMs = deps.maxWaitMs ?? 60_000;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2_000;
    this.leaseMs = deps.leaseMs ?? 120_000;
    this.maxReplays = deps.maxReplays ?? 2;
    this.scanPages = deps.recoveryScanPages ?? 5;
    this.pageSize = deps.recoveryPageSize ?? 50;
  }

  async run<T>(spec: AgentTaskSpec<T>): Promise<AgentTaskOutcome<T>> {
    SafeIdSchema.parse(spec.purpose);
    SafeIdSchema.parse(spec.job.jobId);
    const attempt = spec.attempt ?? 1;
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
    const taskKey = taskKeyFor(spec.job.jobId, spec.role, spec.purpose, attempt);

    const existing = await this.deps.store.get(taskKey);
    if (existing) return this.resume(existing, spec);

    // 1. Credentials never reach a prompt. Refuse before reserving or sending anything.
    if (containsSecret(spec.message, spec.knownSecrets ?? [])) {
      this.log.error("agent_task.refused_credential_in_prompt", { taskKey });
      return { status: "failed", taskKey, code: "credential_in_prompt", message: "prompt contained a credential; not sent", session: null, cost: null };
    }

    const role = ROLE_DEFINITIONS[spec.role];
    if (!Number.isInteger(spec.budgetMicroUsd) || spec.budgetMicroUsd <= 0 || spec.budgetMicroUsd > role.maxTaskMicroUsd) {
      return { status: "failed", taskKey, code: "invalid_task_budget", message: `task budget must be 1..${role.maxTaskMicroUsd} micro-USD`, session: null, cost: null };
    }
    const agent = this.directory[spec.role];

    // 2. Atomic reservation across role-period and job scopes. Idempotent on taskKey.
    const reservation = await this.deps.ledger.reserve({
      reservationId: taskKey,
      jobId: spec.job.jobId,
      amountMicroUsd: spec.budgetMicroUsd,
      scopes: [
        { key: `agent:${spec.role}:${this.deps.budgetPeriodId}`, capMicroUsd: role.periodCapMicroUsd },
        { key: `job:${spec.job.jobId}`, capMicroUsd: spec.jobCapMicroUsd ?? PRICE_TABLE[spec.job.package].jobBudgetMicroUsd },
      ],
    });
    if (!reservation.ok) {
      this.log.warn("agent_task.budget_exhausted", { taskKey, scope: reservation.exhaustedScope });
      return {
        status: "budget_exhausted",
        taskKey,
        exhaustedScope: reservation.exhaustedScope,
        capMicroUsd: reservation.capMicroUsd,
        availableMicroUsd: reservation.availableMicroUsd,
      };
    }

    // 3. Persist intent before any network call.
    const requestBody = this.requestBodyFor(spec, taskKey);
    const now = this.clock.now();
    const record: AgentTaskRecord = {
      taskKey,
      revision: 0,
      jobId: spec.job.jobId,
      role: spec.role,
      purpose: spec.purpose,
      attempt,
      agentId: agent.agentId,
      state: "creating",
      idempotencyKey: `ae-${this.deps.idempotencyNamespace}-${(await sha256Hex(taskKey)).slice(0, 48)}`,
      requestBody,
      reservationId: taskKey,
      budgetMicroUsd: spec.budgetMicroUsd,
      sessionId: null,
      agentVersion: null,
      consumedMicroUsd: null,
      tokenUsage: null,
      result: null,
      error: null,
      replayCount: 0,
      leaseOwner: this.deps.workerId,
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const { inserted, record: stored } = await this.deps.store.insertIfAbsent(record);
    if (!inserted) return this.resume(stored, spec);
    this.log.info("agent_task.intent_persisted", { taskKey, role: spec.role });

    // 4. Create.
    return this.attemptCreate(stored, spec);
  }

  // -------------------------------------------------------------------------

  /** The exact create body for a spec. Also used on resume to prove the stored row answers this request. */
  private requestBodyFor<T>(spec: AgentTaskSpec<T>, taskKey: string): NaiveSessionCreateBody {
    const agent = this.directory[spec.role];
    return {
      agent_id: agent.agentId,
      message: spec.message,
      ...(agent.agentVersion !== undefined ? { agent_version: agent.agentVersion } : {}),
      budget_micro_usd: spec.budgetMicroUsd,
      output_schema: outputJsonSchema(spec.output.schema),
      structured_output_required: true,
      metadata: {
        ae_task_key: taskKey,
        ae_job_id: spec.job.jobId,
        ae_role: spec.role,
        ae_purpose: spec.purpose,
        ae_output: spec.output.name,
        ae_environment: spec.job.environment,
        ae_fixture: spec.job.isFixture,
        ae_package: spec.job.package,
        ae_job_cap_micro_usd: spec.jobCapMicroUsd ?? PRICE_TABLE[spec.job.package].jobBudgetMicroUsd,
      },
    };
  }

  /**
   * A task key names a task, not its input. Before any resume, recovery or stored-result reuse, the
   * durable request body must match the one this spec would send. Otherwise a redeploy with a changed
   * prompt, schema, agent or budget (or a reused job id) would get another request's answer.
   * On mismatch nothing is written, reserved, settled or sent: the stored row stays as evidence.
   */
  private inputMismatch<T>(rec: AgentTaskRecord, spec: AgentTaskSpec<T>): string[] {
    const want = this.requestBodyFor(spec, rec.taskKey) as unknown as Record<string, unknown>;
    const have = (rec.requestBody ?? {}) as unknown as Record<string, unknown>;
    // Older durable bodies predate these metadata fields. Compare every identity field they
    // do contain, without changing the stored body (same-key replays must stay byte compatible).
    const metadata = { ...(want.metadata as Record<string, unknown>) };
    const storedMetadata = (have.metadata ?? {}) as Record<string, unknown>;
    for (const key of ["ae_package", "ae_job_cap_micro_usd"]) {
      if (!(key in storedMetadata)) delete metadata[key];
    }
    want.metadata = metadata;
    const identity = (field: string, body: Record<string, unknown>) =>
      canonicalJson(field === "output_schema" ? stableSchema(body[field]) : body[field]);
    const fields = [...new Set([...Object.keys(have), ...Object.keys(want)])].sort();
    return fields.filter((f) => identity(f, have) !== identity(f, want));
  }

  private mismatchedOutcome<T>(rec: AgentTaskRecord, spec: AgentTaskSpec<T>): AgentTaskOutcome<T> | null {
    const changed = this.inputMismatch(rec, spec);
    if (changed.length === 0) return null;
    this.log.error("agent_task.input_changed", { taskKey: rec.taskKey, state: rec.state, fields: changed });
    return {
      status: "needs_operator",
      taskKey: rec.taskKey,
      code: "task_input_changed",
      message: `stored task was created for a different request (${changed.join(", ")}); bump the attempt to run the new request.`,
      sessionIds: rec.sessionId ? [rec.sessionId] : [],
    };
  }

  private async resume<T>(rec: AgentTaskRecord, spec: AgentTaskSpec<T>): Promise<AgentTaskOutcome<T>> {
    const mismatch = this.mismatchedOutcome(rec, spec);
    if (mismatch) return mismatch;
    switch (rec.state) {
      case "created":
        return this.poll(rec, spec);
      case "creating": {
        if (this.leaseActive(rec)) {
          return { status: "pending", taskKey: rec.taskKey, reason: "create_in_progress_elsewhere", sessionId: null, retryAfterMs: 5_000 };
        }
        // The previous holder may have sent the create and crashed. Never assume it did not.
        const taken = await this.cas(rec, { state: "ambiguous", error: { code: "lease_expired", message: "create outcome unknown after lease expiry" } });
        return taken ? this.recover(taken, spec) : this.reread(rec.taskKey, spec);
      }
      case "ambiguous":
        return this.recover(rec, spec);
      default:
        return this.storedOutcome(rec, spec);
    }
  }

  private leaseActive(rec: AgentTaskRecord): boolean {
    return !!rec.leaseExpiresAt && new Date(rec.leaseExpiresAt).getTime() > this.clock.now().getTime();
  }

  private async attemptCreate<T>(rec: AgentTaskRecord, spec: AgentTaskSpec<T>): Promise<AgentTaskOutcome<T>> {
    // Screen the actual durable bytes under today's policy, including recovery replays.
    // An earlier ambiguous dispatch may have spent money: never release its reservation.
    const body = structuredClone(rec.requestBody);
    if (containsSecret(body.message, spec.knownSecrets ?? [])) {
      return this.escalate(rec, spec, "credential_in_prompt",
        "stored prompt contained a current credential; dispatch refused; reconcile prior intent", []);
    }
    let snap: NaiveSessionSnapshot;
    try {
      snap = await this.deps.naive.createSession(body, rec.idempotencyKey);
    } catch (raw) {
      const err = raw instanceof NaiveCallError ? raw : new NaiveCallError("ambiguous", "unexpected create failure");
      this.log.warn("agent_task.create_error", { taskKey: rec.taskKey, kind: err.kind, status: err.status, code: err.code, requestId: err.requestId });
      if (err.kind === "definitive") {
        await this.deps.ledger.settle(rec.reservationId, 0);
        const done = await this.cas(rec, { state: "failed", error: { code: err.code ?? "create_rejected", message: err.message }, leaseOwner: null, leaseExpiresAt: null });
        if (!done) return this.reread(rec.taskKey, spec);
        return { status: "failed", taskKey: rec.taskKey, code: err.code ?? "create_rejected", message: err.message, session: null, cost: null };
      }
      const code = err.kind === "rate_limited" ? "rate_limited" : err.kind === "in_flight" ? "in_flight" : "ambiguous_create";
      const marked = await this.cas(rec, { state: "ambiguous", error: { code, message: err.message }, leaseOwner: null, leaseExpiresAt: null });
      if (!marked) return this.reread(rec.taskKey, spec);
      return {
        status: "pending",
        taskKey: rec.taskKey,
        reason: err.kind === "rate_limited" ? "rate_limited" : "recovering",
        sessionId: null,
        retryAfterMs: err.kind === "rate_limited" ? 10_000 : 5_000,
      };
    }
    return this.adopt(rec, snap, spec);
  }

  /** Persist the session ID immediately, then wait for it. */
  private async adopt<T>(rec: AgentTaskRecord, snap: NaiveSessionSnapshot, spec: AgentTaskSpec<T>): Promise<AgentTaskOutcome<T>> {
    const saved = await this.cas(rec, {
      state: "created",
      sessionId: snap.id,
      agentVersion: snap.agentVersion,
      error: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    if (!saved) {
      const latest = await this.deps.store.get(rec.taskKey);
      if (latest) {
        const mismatch = this.mismatchedOutcome(latest, spec);
        if (mismatch) return mismatch;
      }
      if (latest?.sessionId && latest.sessionId !== snap.id) {
        return this.escalate(latest, spec, "duplicate_sessions", "two sessions exist for one task", [latest.sessionId, snap.id]);
      }
      return latest ? this.resume(latest, spec) : this.reread(rec.taskKey, spec);
    }
    this.log.info("agent_task.session_persisted", { taskKey: rec.taskKey, sessionId: snap.id });
    if (this.versionMismatch(saved, snap.agentVersion) && snap.status !== "queued" && snap.status !== "running") {
      return this.finalize(saved, snap, spec);
    }
    return this.poll(saved, spec);
  }

  private async recover<T>(rec: AgentTaskRecord, spec: AgentTaskSpec<T>): Promise<AgentTaskOutcome<T>> {
    if (this.leaseActive(rec) && rec.leaseOwner !== this.deps.workerId) {
      return { status: "pending", taskKey: rec.taskKey, reason: "create_in_progress_elsewhere", sessionId: null, retryAfterMs: 5_000 };
    }
    const rateLimited = rec.error?.code === "rate_limited";
    const leased = await this.cas(rec, {
      leaseOwner: this.deps.workerId,
      leaseExpiresAt: new Date(this.clock.now().getTime() + this.leaseMs).toISOString(),
    });
    if (!leased) return this.reread(rec.taskKey, spec);

    if (!rateLimited) {
      // Look the session up by its task key before even considering a replay.
      let found: NaiveSessionSnapshot[];
      try {
        found = await this.scanForTask(leased.agentId, leased.taskKey);
      } catch (e) {
        await this.cas(leased, { leaseOwner: null, leaseExpiresAt: null });
        this.log.warn("agent_task.recovery_scan_failed", { taskKey: rec.taskKey, kind: e instanceof NaiveCallError ? e.kind : "unknown" });
        return { status: "pending", taskKey: rec.taskKey, reason: "naive_unreachable", sessionId: null, retryAfterMs: 10_000 };
      }
      if (found.length > 1) {
        return this.escalate(leased, spec, "duplicate_sessions", "more than one session carries this task key", found.map((s) => s.id));
      }
      if (found.length === 1) {
        this.log.info("agent_task.recovered_by_lookup", { taskKey: rec.taskKey, sessionId: found[0]!.id });
        return this.adopt(leased, found[0]!, spec);
      }
      if (leased.replayCount >= this.maxReplays) {
        return this.escalate(leased, spec, "ambiguous_create_unresolved", "session not found after bounded same-key replays; reconcile manually", []);
      }
    }
    const replay = rateLimited ? leased : await this.cas(leased, { replayCount: leased.replayCount + 1 });
    if (!replay) return this.reread(rec.taskKey, spec);
    this.log.info("agent_task.same_key_replay", { taskKey: rec.taskKey, replayCount: replay.replayCount });
    return this.attemptCreate(replay, spec);
  }

  private async scanForTask(agentId: string, taskKey: string): Promise<NaiveSessionSnapshot[]> {
    const matches: NaiveSessionSnapshot[] = [];
    let after: string | undefined;
    for (let page = 0; page < this.scanPages; page++) {
      const res = await this.deps.naive.listAgentSessions(agentId, { after, limit: this.pageSize });
      for (const s of res.data) if (s.metadata?.ae_task_key === taskKey) matches.push(s);
      if (!res.nextCursor) break;
      after = res.nextCursor;
    }
    return matches;
  }

  private async poll<T>(rec: AgentTaskRecord, spec: AgentTaskSpec<T>): Promise<AgentTaskOutcome<T>> {
    const sessionId = rec.sessionId!;
    const deadline = this.clock.now().getTime() + this.maxWaitMs;
    for (;;) {
      let snap: NaiveSessionSnapshot;
      try {
        snap = await this.deps.naive.getSession(sessionId);
      } catch (error) {
        if (this.versionMismatch(rec, rec.agentVersion)) {
          return this.escalate(rec, spec, "agent_version_mismatch",
            "observed session version differs from the pinned request; reconcile usage manually", [sessionId]);
        }
        if (error instanceof NaiveCallError && error.kind === "definitive" &&
            (error.status === 401 || error.status === 403 || error.status === 404)) {
          // The session may already have spent money. Preserve its identity and reservation;
          // neither a replacement create nor zero-cost settlement is safe here.
          return this.escalate(rec, spec, "session_unavailable",
            "saved session cannot be accessed; reconcile provider access and usage manually", [sessionId]);
        }
        return { status: "pending", taskKey: rec.taskKey, reason: "naive_unreachable", sessionId, retryAfterMs: 10_000 };
      }
      if (snap.status !== "queued" && snap.status !== "running") return this.finalize(rec, snap, spec);
      if (this.versionMismatch(rec, snap.agentVersion) || this.versionMismatch(rec, rec.agentVersion)) {
        return this.escalate(rec, spec, "agent_version_mismatch",
          "observed session version differs from the pinned request; reconcile usage manually", [sessionId]);
      }
      if (this.clock.now().getTime() >= deadline) {
        return { status: "pending", taskKey: rec.taskKey, reason: "session_running", sessionId, retryAfterMs: this.pollIntervalMs * 2 };
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async finalize<T>(rec: AgentTaskRecord, snap: NaiveSessionSnapshot, spec: AgentTaskSpec<T>): Promise<AgentTaskOutcome<T>> {
    const consumed = snap.consumedMicroUsd;
    // Unknown/invalid usage must retain the reservation for reconciliation. In
    // particular, do not let undefined, fractional or unsafe amounts settle as zero
    // in a downstream adapter, or leave a permanently crashing created task.
    if (!Number.isSafeInteger(consumed) || consumed < 0 ||
        !snap.tokenUsage || typeof snap.tokenUsage !== "object" || Array.isArray(snap.tokenUsage) ||
        Object.values(snap.tokenUsage).some(n => !Number.isSafeInteger(n) || n < 0)) {
      return this.escalate(rec, spec, "invalid_session_usage",
        "terminal usage is unavailable or invalid; reconcile provider usage manually", [rec.sessionId!]);
    }
    type Terminal = Pick<AgentTaskRecord, "state" | "result" | "error">;
    let terminal: Terminal;
    const clean = (snap.status === "idle" && snap.stopReason === "end_turn") || snap.status === "completed";

    if (clean) {
      if (snap.structuredOutput === null) {
        terminal = { state: "schema_failed", result: null, error: { code: "no_structured_output", message: "session ended without a structured document" } };
      } else {
        const parsed = spec.output.schema.safeParse(snap.structuredOutput);
        terminal = parsed.success
          ? { state: "completed", result: parsed.data, error: null }
          : { state: "schema_failed", result: null, error: { code: "schema_mismatch", message: zodIssues(parsed.error).join("; ") } };
      }
    } else if (snap.status === "idle" && snap.stopReason === "error" && snap.stopCode === null) {
      terminal = { state: "schema_failed", result: null, error: { code: "required_document_missing", message: "structured output required but not produced" } };
    } else if (snap.status === "idle" && snap.stopReason === "budget_paused") {
      terminal = { state: "budget_paused", result: null, error: { code: "budget_paused", message: "session hit its budget cap" } };
    } else if (snap.status === "idle" && snap.stopReason?.startsWith("awaiting_")) {
      terminal = { state: "needs_operator", result: null, error: { code: "agent_requested_input", message: `session stopped: ${snap.stopReason}` } };
    } else {
      terminal = {
        state: "failed",
        result: null,
        error: { code: snap.stopCode ?? snap.stopReason ?? snap.status, message: `session ended: status=${snap.status} stop_reason=${snap.stopReason ?? "none"}` },
      };
    }

    if (this.versionMismatch(rec, snap.agentVersion) || this.versionMismatch(rec, rec.agentVersion)) {
      terminal = { state: "needs_operator", result: null, error: {
        code: "agent_version_mismatch", message: "observed session version differs from the pinned request; output refused",
      } };
    }
    // The ledger is first-writer-wins, even if terminal CAS rolls back or loses its ack.
    // Persist/deliver that same amount; revised provider usage needs reconciliation.
    const settlement = await this.deps.ledger.settle(rec.reservationId, consumed);
    if (settlement.settledMicroUsd !== consumed) {
      terminal = { state: "needs_operator", result: null, error: {
        code: "settlement_usage_conflict",
        message: `observed usage ${consumed} differs from settled usage ${settlement.settledMicroUsd}; reconcile manually`,
      } };
    }
    const saved = await this.cas(rec, {
      ...terminal,
      consumedMicroUsd: settlement.settledMicroUsd,
      tokenUsage: snap.tokenUsage,
      agentVersion: snap.agentVersion,
    });
    if (!saved) return this.reread(rec.taskKey, spec);
    this.log.info("agent_task.finalized", { taskKey: rec.taskKey, sessionId: snap.id, state: saved.state, consumedMicroUsd: saved.consumedMicroUsd });
    return this.storedOutcome(saved, spec);
  }

  private async escalate<T>(rec: AgentTaskRecord, spec: AgentTaskSpec<T>, code: string, message: string, sessionIds: string[]): Promise<AgentTaskOutcome<T>> {
    const saved = await this.cas(rec, { state: "needs_operator", error: { code, message: `${message}${sessionIds.length ? ` [${sessionIds.join(", ")}]` : ""}` }, leaseOwner: null, leaseExpiresAt: null });
    this.log.error("agent_task.needs_operator", { taskKey: rec.taskKey, code, sessionIds });
    if (!saved) return this.reread(rec.taskKey, spec);
    return { status: "needs_operator", taskKey: rec.taskKey, code, message, sessionIds };
  }

  private versionMismatch(rec: AgentTaskRecord, observed: number | null): boolean {
    const pin = rec.requestBody.agent_version;
    return pin !== undefined && observed !== pin;
  }

  private storedOutcome<T>(rec: AgentTaskRecord, spec: AgentTaskSpec<T>): AgentTaskOutcome<T> {
    const session: SessionInfo | null = rec.sessionId
      ? {
          sessionId: rec.sessionId,
          agentId: rec.agentId,
          agentVersion: rec.agentVersion ?? 0,
          consumedMicroUsd: rec.consumedMicroUsd ?? 0,
          tokenUsage: rec.tokenUsage ?? {},
        }
      : null;
    const cost: CostEntry | null = session
      ? {
          jobId: rec.jobId,
          source: "naive_session",
          role: rec.role,
          externalId: session.sessionId,
          purpose: rec.purpose,
          microUsd: session.consumedMicroUsd,
          measured: rec.consumedMicroUsd !== null,
          recordedAt: rec.updatedAt,
        }
      : null;
    // Older durable terminal rows may have accepted an unverified provider version.
    // Keep their measured accounting evidence, but never return that output as valid.
    if (rec.sessionId && this.versionMismatch(rec, rec.agentVersion)) {
      return { status: "needs_operator", taskKey: rec.taskKey, code: "agent_version_mismatch",
        message: "observed session version differs from the pinned request; output refused",
        sessionIds: [rec.sessionId], cost: rec.consumedMicroUsd === null ? null : cost };
    }
    const code = rec.error?.code ?? rec.state;
    const message = rec.error?.message ?? "";
    switch (rec.state) {
      case "completed": {
        const parsed = spec.output.schema.safeParse(rec.result);
        if (!parsed.success) return { status: "failed", taskKey: rec.taskKey, code: "stored_result_invalid", message: zodIssues(parsed.error).join("; "), session, cost };
        return { status: "completed", taskKey: rec.taskKey, output: parsed.data, session: session!, cost: cost! };
      }
      case "schema_failed":
        return { status: "schema_failed", taskKey: rec.taskKey, session: session!, cost: cost!, issues: message.split("; ") };
      case "budget_paused":
        return { status: "budget_paused", taskKey: rec.taskKey, session: session!, cost: cost! };
      case "needs_operator":
        return { status: "needs_operator", taskKey: rec.taskKey, code, message, sessionIds: rec.sessionId ? [rec.sessionId] : [], cost: rec.consumedMicroUsd === null ? null : cost };
      case "failed":
        return { status: "failed", taskKey: rec.taskKey, code, message, session, cost };
      default:
        return { status: "pending", taskKey: rec.taskKey, reason: "recovering", sessionId: rec.sessionId, retryAfterMs: 5_000 };
    }
  }

  private async cas(rec: AgentTaskRecord, patch: AgentTaskPatch): Promise<AgentTaskRecord | null> {
    return this.deps.store.compareAndSet(rec.taskKey, rec.revision, { ...patch, updatedAt: this.clock.now().toISOString() });
  }

  /** Lost a CAS race: someone else advanced the row. Report its state without acting on it again. */
  private async reread<T>(taskKey: string, spec: AgentTaskSpec<T>): Promise<AgentTaskOutcome<T>> {
    const latest = await this.deps.store.get(taskKey);
    if (!latest) throw new Error(`agent task ${taskKey} disappeared`);
    const mismatch = this.mismatchedOutcome(latest, spec);
    if (mismatch) return mismatch;
    if (latest.state === "creating" || latest.state === "ambiguous") {
      return { status: "pending", taskKey, reason: "create_in_progress_elsewhere", sessionId: latest.sessionId, retryAfterMs: 5_000 };
    }
    if (latest.state === "created") {
      return { status: "pending", taskKey, reason: "session_running", sessionId: latest.sessionId, retryAfterMs: 5_000 };
    }
    return this.storedOutcome(latest, spec);
  }
}

/** Narrow interface the eval services depend on (lets tests inject scripted agents). */
export interface AgentTaskRunner {
  run<T>(spec: AgentTaskSpec<T>): Promise<AgentTaskOutcome<T>>;
}

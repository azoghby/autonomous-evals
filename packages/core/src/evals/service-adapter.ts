/**
 * Adapter from Track B's services to Track A's contract (packages/core/src/contracts/services.ts,
 * origin/track-a 673873d). Implements qualify, auditTrace and renderReport. Target, simulator and
 * branch services are owned elsewhere and are not implemented here.
 *
 * Contract gaps this adapter works around (see docs/track-b-agents.md, "Contract extension needs"):
 * - ServiceContext has no durable session store or budget ledger. `ctx.budgetMicroUsd` is treated
 *   as information only, never as a reservation; reservations go through the injected runner's ledger.
 * - Contract results have no "pending / paused / needs operator" states, so those become typed errors.
 * - The contract TraceAuditResult drops dismissed items, test-defect records and investigator status;
 *   use `auditTraceDetailed` to keep them.
 */
import type { CostEntry as ContractCostEntry, Finding as ContractFinding, IntakeInput, QualifyResult, Report } from "../contracts/index";
import { Finding as ContractFindingSchema } from "../contracts/index";
import type { ServiceContext, TraceAuditResult as ContractTraceAuditResult } from "../contracts/services";
import { type IntakeSummary, qualifyRequest } from "../agents/commercial";
import { type OperatorSummary, writeReportSummary } from "../agents/operator";
import { ROLE_DEFINITIONS } from "../agents/roles";
import { containsSecret, redactSecrets } from "../agents/redact";
import type { AgentTaskRunner } from "../agents/session-service";
import { renderReport as renderArtifacts } from "../reporting/render";
import { auditTrace as runTraceAudit, type TraceAuditOutcome, type TraceAuditResult } from "./trace/audit";
import { byteLength } from "./trace/normalize";
import { type Clock, type CostEntry, type Finding, type JobRef, systemClock } from "./types";

/** Retry later (map to Workflow `RetryableError` with `retryAfterMs`). Nothing was lost or duplicated. */
export class TrackBPendingError extends Error {
  readonly retryable = true;
  constructor(
    readonly retryAfterMs: number,
    readonly reason: string,
  ) {
    super(`Track B task pending: ${reason}`);
    this.name = "TrackBPendingError";
  }
}

/** Do not retry automatically (map to Workflow `FatalError`; move the job to the named state). */
export class TrackBBlockedError extends Error {
  readonly retryable = false;
  constructor(
    readonly code: "paused_budget" | "needs_operator" | "rejected_input" | "agent_failed",
    message: string,
    readonly sessionIds: string[] = [],
  ) {
    super(message);
    this.name = "TrackBBlockedError";
  }
}

export interface TrackBServiceDeps {
  /** An AgentSessionService constructed with Track A's Neon-backed AgentTaskStore and BudgetLedger. */
  runner: AgentTaskRunner;
  /** Authorized job facts the ServiceContext does not carry. Track A must check ownership first. */
  resolveJob(ctx: ServiceContext): Promise<Pick<JobRef, "customerId" | "package" | "isFixture" | "linkedRetestOf" | "quoteVersion">>;
  /** Server-only policy, resolved after job authorization on every invocation/replay. Never put these values in prompts or metadata. */
  resolveKnownSecrets?(ctx: ServiceContext): Promise<readonly string[]>;
  /** Full measured cost list for the report, if available. */
  listJobCosts?(jobId: string): Promise<CostEntry[]>;
  clock?: Clock;
  /** Run the Company operator for the report summary (one extra session). Default true. */
  operatorSummary?: boolean;
}

async function jobOf(deps: TrackBServiceDeps, ctx: ServiceContext): Promise<JobRef> {
  const j = await deps.resolveJob(ctx);
  return { jobId: ctx.jobId, environment: ctx.environment, ...j };
}

async function secretsOf(deps: TrackBServiceDeps, ctx: ServiceContext): Promise<readonly string[]> {
  try {
    const secrets = await deps.resolveKnownSecrets?.(ctx) ?? [];
    if (!Array.isArray(secrets) || secrets.some(s => typeof s !== 'string' || s.length < 4)) throw new Error();
    return [...secrets];
  } catch {
    throw new TrackBBlockedError('needs_operator', 'Secret policy unavailable');
  }
}

function assertSafeContent(value: unknown, knownSecrets: readonly string[]): void {
  if (containsSecret(JSON.stringify(value), knownSecrets)) {
    throw new TrackBBlockedError('rejected_input', 'Credential content refused');
  }
}

/** Cost rows for ctx.recordCost. `meta.idempotencyKey` is unique per session: record it at most once. */
export function toContractCost(c: CostEntry): Omit<ContractCostEntry, "jobId"> {
  return {
    source: "naive",
    agent: c.role ? ROLE_DEFINITIONS[c.role].costLabel : undefined,
    sessionId: c.externalId ?? undefined,
    microUsd: c.microUsd,
    meta: { purpose: c.purpose, measured: c.measured, idempotencyKey: `naive:${c.externalId}` },
  };
}

const CONTRACT_CATEGORIES = new Set<ContractFinding["category"]>([
  "unsupported_claim", "ignored_error", "instruction_violation", "unsafe_action", "factual", "state_mismatch", "false_success", "other",
]);

export function toContractFinding(f: Finding): ContractFinding {
  const category = (CONTRACT_CATEGORIES.has(f.category as ContractFinding["category"]) ? f.category : "other") as ContractFinding["category"];
  const description = [f.summary, f.investigatorNote ? `Investigator: ${f.investigatorNote}` : null, f.basis === "unspecified" ? null : `Basis: ${f.basis}.`].filter(Boolean).join("\n\n");
  return ContractFindingSchema.parse({
    id: f.id,
    title: f.title.slice(0, 300),
    status: f.label,
    severity: f.severity,
    category,
    description: description.slice(0, 5_000),
    scenarioId: f.evidence.find((e) => e.kind === "scenario_response")?.scenarioId,
    evidence: f.evidence.map((e) =>
      e.kind === "trace_event"
        ? { kind: "trace_excerpt", excerpt: e.quote.slice(0, 10_000), location: `event ${e.eventId}` }
        : e.kind === "scenario_response"
          ? { kind: "response", excerpt: e.quote.slice(0, 10_000), location: `scenario ${e.scenarioId} run ${e.runId}` }
          : { kind: "judge", excerpt: e.detail.slice(0, 10_000), location: `check ${e.checkId}` },
    ),
    reproductions: f.reproduction?.attempted ? 1 : 0,
  });
}

/** Lossy inverse for rendering contract findings (basis is not in the contract). */
export function fromContractFinding(f: ContractFinding): Finding {
  return {
    id: f.id,
    source: f.scenarioId ? "text_eval" : "trace_audit",
    category: f.category,
    title: f.title,
    label: f.status,
    severity: f.severity === "critical" ? "high" : f.severity,
    basis: "unspecified",
    summary: f.description,
    evidence: f.evidence.map((e) => {
      const loc = e.location ?? "";
      if (e.kind === "response") return { kind: "scenario_response", scenarioId: f.scenarioId ?? loc, runId: loc, quote: e.excerpt, truncated: false };
      if (e.kind === "judge" || e.kind === "state_diff") return { kind: "check", checkId: loc || e.kind, detail: e.excerpt };
      return { kind: "trace_event", eventId: loc.replace(/^event /, "") || "?", quote: e.excerpt, truncated: false };
    }),
    investigatorNote: null,
    reproduction: f.reproductions > 0 ? { attempted: true, reproduced: null, runId: null } : null,
  };
}

function intakeSummary(intake: IntakeInput, clarifications: string[], knownSecrets: readonly string[] = []): { summary: IntakeSummary; secrets: string[] } {
  const host = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  };
  switch (intake.package) {
    case "trace_audit":
      return {
        summary: { requestedPackage: "trace_audit", notes: intake.notes ?? null, systemPromptExcerpt: intake.systemPrompt ?? null, trace: { bytes: byteLength(intake.trace), preview: redactSecrets(intake.trace, knownSecrets).text.slice(0, 1_500) }, endpointHost: null, clarifications },
        secrets: [],
      };
    case "text_eval":
    case "workflow_eval":
      return {
        summary: { requestedPackage: intake.package, notes: intake.notes ?? null, systemPromptExcerpt: intake.endpoint.systemPrompt || null, trace: null, endpointHost: host(intake.endpoint.url), clarifications },
        secrets: intake.endpoint.apiKey ? [intake.endpoint.apiKey] : [],
      };
    case "version_comparison":
      return {
        summary: {
          requestedPackage: "version_comparison",
          notes: `${intake.notes ?? ""}\nMode: ${intake.mode}`.trim(),
          systemPromptExcerpt: intake.endpointA.systemPrompt || null,
          trace: null,
          endpointHost: [host(intake.endpointA.url), host(intake.endpointB.url)].filter(Boolean).join(", "),
          clarifications,
        },
        secrets: [intake.endpointA.apiKey, intake.endpointB.apiKey].filter((k): k is string => !!k),
      };
  }
}

function throwForNonCompleted(o: { status: string } & Record<string, unknown>): never {
  switch (o.status) {
    case "pending":
      throw new TrackBPendingError(Number(o.retryAfterMs ?? 5_000), String(o.reason ?? "pending"));
    case "budget_exhausted":
    case "budget_paused":
    case "paused_budget":
      throw new TrackBBlockedError("paused_budget", String(o.detail ?? o.exhaustedScope ?? "budget exhausted"));
    case "needs_operator":
      throw new TrackBBlockedError("needs_operator", String(o.message ?? o.code), (o.sessionIds as string[]) ?? []);
    case "rejected_input":
      throw new TrackBBlockedError("rejected_input", String(o.message));
    case "schema_failed":
      throw new TrackBBlockedError("agent_failed", `schema_failed: ${Array.isArray(o.issues) ? o.issues.slice(0, 3).join('; ') : 'structured output did not match the required schema'}`);
    default:
      throw new TrackBBlockedError("agent_failed", `${String(o.code ?? o.status)}: ${String(o.message ?? "")}`);
  }
}

export function createTrackBServices(deps: TrackBServiceDeps) {
  const clock = deps.clock ?? systemClock;

  async function auditTraceDetailed(ctx: ServiceContext, trace: string, systemPrompt?: string): Promise<TraceAuditResult> {
    const job = await jobOf(deps, ctx);
    const knownSecrets = await secretsOf(deps, ctx);
    await ctx.recordProgress("investigating", "Checking claims against the log");
    const outcome: TraceAuditOutcome = await runTraceAudit({ job, trace, systemPrompt: systemPrompt ?? null, knownSecrets }, { runner: deps.runner, clock });
    if ("costs" in outcome) for (const c of outcome.costs ?? []) await ctx.recordCost(toContractCost(c));
    if (outcome.status !== "completed") throwForNonCompleted(outcome as never);
    for (const c of outcome.result.costs) await ctx.recordCost(toContractCost(c));
    assertSafeContent(outcome.result, knownSecrets);
    return outcome.result;
  }

  return {
    async qualify(ctx: ServiceContext, intake: IntakeInput, clarifications: string[]): Promise<QualifyResult> {
      const job = await jobOf(deps, ctx);
      const knownSecrets = await secretsOf(deps, ctx);
      const { summary, secrets } = intakeSummary(intake, clarifications, knownSecrets);
      const outcome = await qualifyRequest({ job, intake: summary, round: clarifications.length, knownSecrets: [...knownSecrets, ...secrets] }, deps.runner);
      if ("cost" in outcome && outcome.cost) await ctx.recordCost(toContractCost(outcome.cost));
      if (outcome.status !== "completed") throwForNonCompleted(outcome as never);
      const q = outcome.value;
      assertSafeContent(q, knownSecrets);
      return {
        decision: q.decision,
        package: q.package,
        questions: q.questions,
        scopeSummary: q.scopeSummary,
        deliverables: q.deliverables,
        ...(q.declineReason ? { declineReason: q.declineReason } : {}),
      };
    },

    auditTraceDetailed,

    async auditTrace(ctx: ServiceContext, trace: string, systemPrompt?: string): Promise<ContractTraceAuditResult> {
      const r = await auditTraceDetailed(ctx, trace, systemPrompt);
      return { findings: r.findings.map(toContractFinding), claimsChecked: r.claims.length };
    },

    async renderReport(
      ctx: ServiceContext,
      input: { intake: IntakeInput; findings: ContractFinding[]; limitations?: string[]; richFindings?: Finding[] },
    ): Promise<Report> {
      const job = await jobOf(deps, ctx);
      const knownSecrets = await secretsOf(deps, ctx);
      const findings = input.richFindings ?? input.findings.map(fromContractFinding);
      const limitations = input.limitations ?? ["Only the supplied material was examined."];
      assertSafeContent({ job, findings, limitations }, knownSecrets);
      let operatorSummary: OperatorSummary | null = null;
      if (deps.operatorSummary ?? true) {
        const s = await writeReportSummary({ job, findings, limitations }, {
          run: spec => deps.runner.run({ ...spec, knownSecrets }),
        });
        const cost = "cost" in s ? s.cost : null;
        if (cost) await ctx.recordCost(toContractCost(cost));
        if (s.status === "pending") throw new TrackBPendingError(s.retryAfterMs, s.reason);
        if (s.status === "budget_exhausted" || s.status === "budget_paused") throwForNonCompleted(s as never);
        // Any other failure: the report uses the code-generated summary (labeled as such).
        if (s.status === "completed") operatorSummary = s.value;
      }
      const rendered = renderArtifacts({
        job,
        generatedAt: clock.now().toISOString(),
        findings,
        limitations,
        operatorSummary,
        costs: deps.listJobCosts ? await deps.listJobCosts(ctx.jobId) : null,
        includeMonitoringPitch: true,
        includeHtml: true,
      });
      assertSafeContent(rendered.json, knownSecrets);
      return {
        jobId: ctx.jobId,
        summary: rendered.summary.slice(0, 10_000),
        markdown: rendered.markdown,
        html: rendered.html ?? "",
        // Preserve the contract artifact verbatim when no richer authoritative input
        // was supplied. The rendering inverse cannot reconstruct lost provenance.
        findings: input.richFindings ? findings.map(toContractFinding) : input.findings.map(f => ContractFindingSchema.parse(f)),
        ...(rendered.monitoringPitch ? { monitoringPitch: rendered.monitoringPitch.slice(0, 2_000) } : {}),
      };
    },
  };
}

import { TextFactualGapError } from '@ae/core/evals/text/factual-gap';
import { objectivePassed } from "@ae/core/contracts/services";
import "server-only";
import {
  Finding, QualifyResult, Remediation, Report, Suite, type IntakeInput,
} from "@ae/core/contracts/index";
import type { EvalServices, ServiceContext, RunResult } from "@ae/core/contracts/services";
import { assertPublicTarget } from "./target-url";
import { mockRedTeamFindings, mockRedTeamResults } from "./redteam-mock";
import {
  evalServices as trackBServices, EvalServiceConfigError, EvalServiceUnavailableError, TrackBBlockedError, TrackBPendingError,
} from "@ae/core/integration/eval-services";
import { FatalError, RetryableError } from "workflow";
import { createLiteServices, LiteJudgeOutageError, LiteUnavailableError } from "@ae/core/lite/index";
import { resolveJobTarget } from "./lite-target";

import { readRoutingSelection, routeNaiveMethods, type NaiveMethodBuilder } from "./naive-method-routing";

const MOCK = "[MOCK]";
const MOCK_CLARIFY_MARKER = "[needs-clarification]";
const MOCK_MIN_TRACE_CHARS = 20;

type FixTemplate = Pick<Remediation, "kind" | "summary" | "patch" | "rationale"> & { after: number; total: number };

const FIX_TEMPLATES: Record<Finding["category"], FixTemplate> = {
  unsupported_claim: {
    kind: "prompt_patch", total: 1, after: 1,
    summary: "Only report success when a tool result confirms it.",
    patch: "+ Never state that an action succeeded (booked, sent, refunded, saved) unless the corresponding tool result explicitly confirms it.\n+ If a tool call failed or returned no confirmation, say so and offer the next step.",
    rationale: "The agent claimed success after a failed or unconfirmed tool call. Tying claims to tool results removes the unsupported statement.",
  },
  false_success: {
    kind: "prompt_patch", total: 1, after: 1,
    summary: "Require explicit confirmation before declaring success.",
    patch: "+ Before telling the user a task is done, re-read the latest tool output and quote the confirmation. If there is none, report the task as not completed.",
    rationale: "Success was declared without confirmation from the system of record.",
  },
  ignored_error: {
    kind: "prompt_patch", total: 1, after: 1,
    summary: "Surface tool errors instead of continuing.",
    patch: "+ When a tool returns an error, stop, tell the user what failed, and retry or escalate. Never continue as if the call succeeded.",
    rationale: "A tool error was ignored and later steps built on a failed result.",
  },
  instruction_violation: {
    kind: "prompt_patch", total: 1, after: 1,
    summary: "Restate the violated instruction as a hard rule.",
    patch: "+ HARD RULE: follow every instruction in this prompt, even when the user asks otherwise. If a request conflicts, decline that part and explain why.",
    rationale: "The response broke an explicit system-prompt instruction; a restated hard rule makes it non-negotiable.",
  },
  unsafe_action: {
    kind: "guardrail", total: 1, after: 1,
    summary: "Block destructive tool calls without explicit user confirmation.",
    patch: "guardrail: require_confirmation\n  tools: [delete_*, refund_*, send_*]\n  condition: no user confirmation in the previous turn\n  action: refuse_and_ask",
    rationale: "A high-impact action ran without confirmation. A guardrail on the tool layer is more reliable than a prompt instruction.",
  },
  state_mismatch: {
    kind: "tool_schema", total: 1, after: 1,
    summary: "Return the resulting state from mutating tools.",
    patch: "--- tool: update_record\n+++ tool: update_record\n@@ returns @@\n+  state: { id: string, status: string, updated_at: string }",
    rationale: "The agent's claim diverged from real state because the tool did not return it. Returning the new state lets the agent report truthfully.",
  },
  factual: {
    kind: "prompt_patch", total: 2, after: 1,
    summary: "Ground answers in the provided reference text.",
    patch: "+ Answer only from the reference material. If it does not contain the answer, say you do not know.",
    rationale: "The answer contradicted or went beyond the reference text.",
  },
  other: {
    kind: "other", total: 1, after: 0,
    summary: "Needs manual review; no automatic fix verified.",
    patch: "No automatic patch proposed.",
    rationale: "This finding does not map to a known remediation pattern.",
  },
};

const mockRemediation = (finding: Finding): Remediation => {
  const t = FIX_TEMPLATES[finding.category];
  const status = t.after === t.total ? "verified" : t.after === 0 ? "not_verified" : "partially_verified";
  return Remediation.parse({
    findingId: finding.id, kind: t.kind, summary: `${MOCK} ${t.summary}`, patch: t.patch, rationale: `${MOCK} ${t.rationale}`,
    verification: {
      status, before: { passed: 0, total: t.total }, after: { passed: t.after, total: t.total }, regressions: 0,
      evidence: [{
        kind: "judge", location: finding.scenarioId ? `scenario ${finding.scenarioId}` : "trace re-check",
        excerpt: `${MOCK} Deterministic fixture: re-check with the patch applied passed ${t.after}/${t.total} (was 0/${t.total}). Not produced by a real run.`,
      }],
    },
  });
};

const mockFinding = (id: string, scenarioId?: string): Finding => Finding.parse({
  id, title: `${MOCK} Unsupported success claim`, status: "confirmed", severity: "high", category: "unsupported_claim",
  description: `${MOCK} Deterministic fixture finding. Not produced by a real evaluation.`,
  ...(scenarioId ? { scenarioId } : {}),
  evidence: [{ kind: "trace_excerpt", excerpt: `${MOCK} "Booking confirmed" appears after a failed tool call.`, location: "step 3" }],
  reproductions: 0,
});

/** Deterministic MOCK services. Jobs served by these must carry jobs.is_mock = true and never count as revenue. */
export const mockServices: EvalServices = {
  async qualify(_ctx, intake: IntakeInput, clarifications) {
    // Deterministic clarification path: the marker (in trace/notes), or a trace shorter than the minimum, asks once.
    const description = `${intake.package === "trace_audit" ? intake.trace : ""}\n${intake.notes ?? ""}`;
    const tooShort = intake.package === "trace_audit" && intake.trace.trim().length < MOCK_MIN_TRACE_CHARS;
    if (clarifications.length === 0 && (description.includes(MOCK_CLARIFY_MARKER) || tooShort)) {
      return QualifyResult.parse({
        decision: "clarify", package: intake.package,
        questions: [`${MOCK} What specific agent behavior should this review focus on?`],
        scopeSummary: `${MOCK} Need more detail before quoting.`, deliverables: [],
      });
    }
    return QualifyResult.parse({
      decision: "quote", package: intake.package, questions: [],
      scopeSummary: `${MOCK} ${intake.package} review${clarifications.length ? ` (${clarifications.length} clarification(s) considered)` : ""}.`,
      deliverables: ["Findings report", "Evidence appendix"],
    });
  },
  async auditTrace(_ctx, trace) {
    // Deterministic heuristic: a failed tool result in the trace means the fixture finding applies; clean traces have none.
    const hasFailedTool = /\\"error\\"|"error"\s*:/i.test(trace);
    return { findings: hasFailedTool ? [mockFinding("mock-f1")] : [], claimsChecked: 3 };
  },
  async checkTarget(_ctx, endpoint) {
    const reason = await assertPublicTarget(endpoint.url);
    return reason ? { ok: false, detail: `${MOCK} ${reason}` } : { ok: true, detail: `${MOCK} connection check skipped` };
  },
  async designSuite(ctx) {
    return Suite.parse({
      jobId: ctx.jobId, versionLabel: "default", frozenAt: "2026-01-01T00:00:00.000Z",
      scenarios: [{
        id: "mock-s1", title: `${MOCK} Basic scenario`, category: "mock", input: "Hello",
        checks: [{ kind: "objective", description: "Responds", spec: {} }],
      }],
    });
  },
  async runSuite(_ctx, suite): Promise<RunResult> {
    const base = { scenarioId: "mock-s1", passed: false, detail: `${MOCK} failed` };
    return { runId: "mock-run", versionLabel: suite.versionLabel, results: [base, ...mockRedTeamResults(suite.scenarios)] };
  },
  async investigate(_ctx, suite, runs) {
    const failed = new Set(runs.flatMap((r) => r.results.filter((x) => objectivePassed(x) === false).map((x) => x.scenarioId)));
    return [mockFinding("mock-f1", "mock-s1"), ...mockRedTeamFindings(suite.scenarios, failed)];
  },
  async proposeAndVerifyFix(_ctx, input) { return mockRemediation(input.finding); },
  async renderReport(ctx, input) {
    const fixes = input.remediations ?? [];
    const titleOf = new Map(input.findings.map((f) => [f.id, f.title]));
    const fixSection = fixes.length === 0 ? "" : `\n## Validated fixes\n\n${fixes.map((r) =>
      `### ${titleOf.get(r.findingId) ?? r.findingId}\n- **Fix (${r.kind}):** ${r.summary}\n- **Status:** ${r.verification.status}; before ${r.verification.before.passed}/${r.verification.before.total}, after ${r.verification.after.passed}/${r.verification.after.total}, ${r.verification.regressions} regression(s)\n- **Why:** ${r.rationale}\n\n\`\`\`\n${r.patch}\n\`\`\`\n`).join("\n")}`;
    return Report.parse({
      jobId: ctx.jobId, summary: `${MOCK} ${input.findings.length} finding(s), ${fixes.filter((r) => r.verification.status === "verified").length} validated fix(es).`,
      markdown: `# ${MOCK} Report\n\n${input.findings.map((f) => `- **${f.title}** (${f.severity})`).join("\n")}\n${fixSection}`,
      html: `<h1>${MOCK} Report</h1>`, findings: input.findings,
    });
  },
  async createJobBranch(jobId) { return { branchId: `mock-branch-${jobId}`, connectionString: "postgres://mock" }; },
  async deleteJobBranch() {},
  async getJobBranchConnection() { return "postgres://mock"; },
  async rerunFinding(_ctx: ServiceContext, finding) {
    return Finding.parse({ ...finding, reproductions: Math.min(3, finding.reproductions + 1), description: `${MOCK} rerun: ${finding.description}` });
  },
};

export type EvalServicesMode = "mock" | "real" | "lite";
export function evalServicesMode(): EvalServicesMode {
  const v = process.env.EVAL_SERVICES;
  return v === "real" || v === "lite" ? v : "mock";
}
export function isMockServices(): boolean {
  return evalServicesMode() === "mock";
}

let real: EvalServices | undefined;
/** Resolve each job's durable profile before constructing a selected paid method. */
const defaultNaiveBuilder: NaiveMethodBuilder = async (method, ctx) => {
  const { resolveJobNaiveExecution } = await import('./naive-text-execution-runtime');
  const selected = await resolveJobNaiveExecution(ctx.jobId);
  if (!selected.generic) throw new FatalError('NAIVE_RECONCILIATION_REQUIRED');
  const { createNaiveTextMethodBuilder } = await import('./naive-text-methods');
  return createNaiveTextMethodBuilder({executionProfile:selected.profile})(method, ctx);
};

/** Maps Track B's typed errors onto Workflow semantics: pending -> RetryableError; blocked/unavailable/unconfigured -> FatalError. */
export function toWorkflowError(error: unknown): unknown {
  if (error instanceof TextFactualGapError) return error;
  if (error instanceof TrackBPendingError) return new RetryableError(error.message, { retryAfter: error.retryAfterMs });
  // Judge outage: never deliver an empty report; retry the step (bounded by workflow step retries, then operator alert).
  if (error instanceof LiteJudgeOutageError) return new RetryableError(error.message, { retryAfter: 60_000 });
  if (
    error instanceof TrackBBlockedError || error instanceof EvalServiceUnavailableError
    || error instanceof EvalServiceConfigError || error instanceof LiteUnavailableError
  ) {
    return new FatalError(error.message);
  }
  return error;
}

function withWorkflowErrors(services: EvalServices): EvalServices {
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(services)) {
    if (typeof fn !== "function") continue;
    wrapped[name] = async (...args: unknown[]) => {
      try {
        return await (fn as (...a: unknown[]) => Promise<unknown>).apply(services, args);
      } catch (error) {
        throw toWorkflowError(error);
      }
    };
  }
  return wrapped as unknown as EvalServices;
}

/**
 * Hybrid: each Track B method runs first; if it throws EvalServiceUnavailableError (not yet built),
 * the same call is served by the lite engine. Other errors (blocked, pending, config) propagate.
 */
export function withLiteFallback(primary: EvalServices, fallback: EvalServices): EvalServices {
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(primary)) {
    if (typeof fn !== "function") continue;
    const alt = (fallback as unknown as Record<string, unknown>)[name];
    out[name] = async (...args: unknown[]) => {
      try {
        return await (fn as (...a: unknown[]) => Promise<unknown>).apply(primary, args);
      } catch (error) {
        if (!(error instanceof EvalServiceUnavailableError) || typeof alt !== "function") throw error;
        return (alt as (...a: unknown[]) => Promise<unknown>).apply(fallback, args);
      }
    };
  }
  return out as unknown as EvalServices;
}

let lite: EvalServices | undefined;
let sharedLite: EvalServices | undefined;
/** Lite engine wired with a durable (DB-backed) target resolver so investigate/rerunFinding work across serverless steps. */
function liteServices(): EvalServices {
  sharedLite ??= createLiteServices({ resolveTarget: resolveJobTarget });
  return sharedLite;
}

/**
 * EVAL_SERVICES=mock (default) -> deterministic fixtures.
 * EVAL_SERVICES=real -> Track B engine (@ae/core/integration/eval-services), lite engine for methods Track B marks unavailable.
 * EVAL_SERVICES=lite -> lite engine only (@ae/core/lite: AI gateway + SSRF-safe target transport).
 * All lazy; no I/O until first call.
 */
export async function getEvalServices(builder: NaiveMethodBuilder = defaultNaiveBuilder): Promise<EvalServices> {
  const selection = readRoutingSelection();
  const mode = evalServicesMode();
  if (mode === "mock") return selection.realBranches === undefined ? mockServices : withWorkflowErrors(routeNaiveMethods(mockServices, trackBServices, selection, builder));
  if (mode === "lite") {
    lite ??= withWorkflowErrors(liteServices());
    return selection.realBranches === undefined ? lite : withWorkflowErrors(routeNaiveMethods(lite, trackBServices, selection, builder));
  }
  real ??= withWorkflowErrors(withLiteFallback(trackBServices, liteServices()));
  return withWorkflowErrors(routeNaiveMethods(real, trackBServices, selection, builder));
}

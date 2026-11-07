import "server-only";
import {
  Finding, QualifyResult, Remediation, Report, Suite, type IntakeInput,
} from "@ae/core/contracts/index";
import type { EvalServices, ServiceContext, RunResult } from "@ae/core/contracts/services";
import { assertPublicTarget } from "./target-url";

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
  async runSuite(): Promise<RunResult> {
    return { runId: "mock-run", versionLabel: "default", results: [{ scenarioId: "mock-s1", passed: false, detail: `${MOCK} failed` }] };
  },
  async investigate() { return [mockFinding("mock-f1", "mock-s1")]; },
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

export function isMockServices(): boolean {
  return process.env.EVAL_SERVICES !== "real";
}

let real: EvalServices | undefined;

export async function getEvalServices(): Promise<EvalServices> {
  if (isMockServices()) return mockServices;
  if (real) return real;
  // TODO(Track B): "@ae/core/evals/index" must export `evalServices: EvalServices`.
  const modPath = "@ae/core/evals/index";
  const mod = (await import(/* webpackIgnore: true */ modPath).catch(() => null)) as { evalServices?: EvalServices } | null;
  if (!mod?.evalServices) throw new Error("EVAL_SERVICES=real but @ae/core/evals/index (evalServices) is not available");
  real = mod.evalServices;
  return real;
}

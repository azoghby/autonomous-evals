import "server-only";
import {
  Finding, QualifyResult, Report, Suite, type IntakeInput,
} from "@ae/core/contracts/index";
import type { EvalServices, ServiceContext, RunResult } from "@ae/core/contracts/services";

const MOCK = "[MOCK]";

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
    return QualifyResult.parse({
      decision: "quote", package: intake.package, questions: [],
      scopeSummary: `${MOCK} ${intake.package} review${clarifications.length ? ` (${clarifications.length} clarification(s) considered)` : ""}.`,
      deliverables: ["Findings report", "Evidence appendix"],
    });
  },
  async auditTrace() { return { findings: [mockFinding("mock-f1")], claimsChecked: 3 }; },
  async checkTarget(_ctx, endpoint) {
    return endpoint.url.startsWith("https://")
      ? { ok: true, detail: `${MOCK} connection check skipped` }
      : { ok: false, detail: `${MOCK} endpoint must use HTTPS` };
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
  async renderReport(ctx, input) {
    return Report.parse({
      jobId: ctx.jobId, summary: `${MOCK} ${input.findings.length} finding(s).`,
      markdown: `# ${MOCK} Report\n\n${input.findings.map((f) => `- **${f.title}** (${f.severity})`).join("\n")}\n`,
      html: `<h1>${MOCK} Report</h1>`, findings: input.findings,
    });
  },
  async createJobBranch(jobId) { return { branchId: `mock-branch-${jobId}`, connectionString: "postgres://mock" }; },
  async deleteJobBranch() {},
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

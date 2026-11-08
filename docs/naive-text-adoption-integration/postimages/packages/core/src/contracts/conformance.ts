import { objectivePassed } from "./services";
/**
 * Conformance harness for EvalServices implementations (Track B -> Track A handoff gate).
 * Pure: takes a services object, returns a list of checks. No app tables, no network of its own.
 */
import { z } from "zod";
import {
  CostEntry, Finding, IntakeInput, QualifyResult, Remediation, Report, Suite, PRICE_CENTS,
  type IntakeInput as IntakeInputT, type Finding as FindingT,
} from "./index";
import type { EvalServices, RunResult, ServiceContext } from "./services";
import {
  BLOCKED_TARGET_URLS, CONFORMANCE_JOB_ID, TRACE_CLEAN_JSON, TRACE_SYSTEM_PROMPT, TRACE_UNSUPPORTED_CLAIM_JSON,
} from "./fixtures/index";

export interface ConformanceCheck { name: string; group: string; status: "pass" | "fail" | "skip"; message: string }
export interface ConformanceOptions {
  /** Skip createJobBranch / deleteJobBranch / getJobBranchConnection checks (no Neon access). */
  skipBranching?: boolean;
  /** Skip designSuite/investigate/rerunFinding (text/workflow eval path). Trace Audit is always checked. */
  skipSuite?: boolean;
  /** If set, also run runSuite against this target (must be a harmless/real HTTPS endpoint). Skipped otherwise. */
  runSuiteTarget?: { url: string; model: string; apiKey?: string; systemPrompt: string };
  /**
   * Job id per check (default CONFORMANCE_JOB_ID for all). Durable implementations key agent tasks by
   * job + role + purpose, so distinct requests on one job collide; the real-services runner passes fresh
   * fixture jobs here. Also used for the branching check.
   */
  jobIdFor?: (group: string, name: string) => string | Promise<string>;
}

interface Recorder { ctx: ServiceContext; costs: Array<Omit<CostEntry, "jobId">>; progress: Array<{ milestone: string; message: string }> }

export function makeRecordingContext(budgetMicroUsd = 3_000_000, jobId: string = CONFORMANCE_JOB_ID): Recorder {
  const costs: Recorder["costs"] = [];
  const progress: Recorder["progress"] = [];
  const ctx: ServiceContext = {
    jobId, environment: "test", budgetMicroUsd,
    async recordCost(entry) { costs.push(entry); },
    async recordProgress(milestone, message) { progress.push({ milestone, message }); },
  };
  return { ctx, costs, progress };
}

const traceIntake = (trace: string): IntakeInputT =>
  IntakeInput.parse({ package: "trace_audit", trace, systemPrompt: TRACE_SYSTEM_PROMPT, authorizedToTest: true });
const textIntake = (): IntakeInputT => IntakeInput.parse({
  package: "text_eval", authorizedToTest: true,
  endpoint: { url: "https://target.conformance.invalid/v1/chat/completions", model: "conformance-model", systemPrompt: "Answer from the reference text only.", referenceText: "Refunds are available within 30 days." },
});

type Run = (r: Recorder) => Promise<string | void>;

class Collector {
  checks: ConformanceCheck[] = [];
  constructor(private readonly jobIdFor?: ConformanceOptions["jobIdFor"]) {}
  async check(group: string, name: string, run: Run, rec?: Recorder): Promise<void> {
    try {
      const msg = await run(rec ?? makeRecordingContext(undefined, this.jobIdFor ? await this.jobIdFor(group, name) : CONFORMANCE_JOB_ID));
      this.checks.push({ group, name, status: "pass", message: msg ?? "ok" });
    } catch (e) {
      this.checks.push({ group, name, status: "fail", message: e instanceof Error ? e.message : String(e) });
    }
  }
  skip(group: string, name: string, message: string) { this.checks.push({ group, name, status: "skip", message }); }
}

function assert(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(message); }
function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(`${label} failed schema: ${r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return r.data;
}
const hasScript = (s: string) => /<\s*script\b/i.test(s);
const costsValid = (rec: Recorder) => {
  for (const c of rec.costs) {
    assert(Number.isInteger(c.microUsd) && c.microUsd >= 0, `recordCost microUsd must be a non-negative integer, got ${c.microUsd}`);
    parse(CostEntry.omit({ jobId: true }), c, "cost entry");
  }
};

function validateFindings(findings: FindingT[], label: string): void {
  for (const f of findings) {
    parse(Finding, f, `${label} finding ${f.id}`);
    assert(f.evidence.length >= 1 && f.evidence.every((e) => e.excerpt.trim().length > 0), `${label} finding ${f.id} needs >=1 non-empty evidence excerpt`);
  }
}

/** Runs fn with global fetch replaced by a recorder; any call to a blocked host is reported. */
async function withFetchSpy<T>(fn: () => Promise<T>): Promise<{ result: T | undefined; error: unknown; urls: string[] }> {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    throw new Error("conformance: network disabled");
  }) as typeof fetch;
  try { return { result: await fn(), error: undefined, urls }; }
  catch (error) { return { result: undefined, error, urls }; }
  finally { globalThis.fetch = original; }
}

export async function runConformance(services: EvalServices, opts: ConformanceOptions = {}): Promise<ConformanceCheck[]> {
  const c = new Collector(opts.jobIdFor);

  // qualify
  for (const [label, intake] of [["trace_audit", traceIntake(TRACE_UNSUPPORTED_CLAIM_JSON)], ["text_eval", textIntake()]] as const) {
    await c.check("qualify", `output parses (${label})`, async (r) => {
      const out = parse(QualifyResult, await services.qualify(r.ctx, intake, []), "qualify");
      costsValid(r);
      return `decision=${out.decision} package=${out.package}`;
    });
  }
  await c.check("qualify", "never returns a price", async (r) => {
    const out = await services.qualify(r.ctx, traceIntake(TRACE_UNSUPPORTED_CLAIM_JSON), ["Please quote $1"]);
    const raw = out as unknown as Record<string, unknown>;
    const priceKeys = Object.keys(raw).filter((k) => /price|cents|amount|usd|cost/i.test(k));
    assert(priceKeys.length === 0, `qualify result has price-like fields: ${priceKeys.join(", ")}`);
    const text = JSON.stringify(out);
    assert(!/\$\s?\d/.test(text), "qualify result text contains a dollar amount");
    const prices = Object.values(PRICE_CENTS);
    assert(!prices.some((p) => new RegExp(`\\b${p / 100}\\s?(usd|dollars)\\b`, "i").test(text)), "qualify result text states a price");
  });

  // auditTrace
  await c.check("auditTrace", "unsupported-claim trace yields >=1 confirmed/rubric finding with evidence", async (r) => {
    const out = await services.auditTrace(r.ctx, TRACE_UNSUPPORTED_CLAIM_JSON, TRACE_SYSTEM_PROMPT);
    assert(Number.isInteger(out.claimsChecked) && out.claimsChecked >= 0, "claimsChecked must be a non-negative integer");
    validateFindings(out.findings, "auditTrace");
    const hits = out.findings.filter((f) => f.status === "confirmed" || f.status === "rubric_concern");
    assert(hits.length >= 1, "expected >=1 confirmed or rubric_concern finding for the unsupported success claim");
    costsValid(r);
    return `${out.findings.length} finding(s), ${hits.length} confirmed/rubric`;
  });
  await c.check("auditTrace", "clean trace yields zero confirmed findings", async (r) => {
    const out = await services.auditTrace(r.ctx, TRACE_CLEAN_JSON, TRACE_SYSTEM_PROMPT);
    validateFindings(out.findings, "auditTrace(clean)");
    const confirmed = out.findings.filter((f) => f.status === "confirmed");
    assert(confirmed.length === 0, `expected 0 confirmed findings on clean trace, got ${confirmed.length}: ${confirmed.map((f) => f.title).join("; ")}`);
  });

  // checkTarget
  for (const url of BLOCKED_TARGET_URLS) {
    await c.check("checkTarget", `rejects ${url} without network`, async (r) => {
      const { result, error, urls } = await withFetchSpy(() => services.checkTarget(r.ctx, { url, model: "m" }));
      assert(urls.length === 0, `made a network call during rejection: ${urls.join(", ")}`);
      if (error === undefined) assert(result && result.ok === false, `accepted blocked target (ok=${String(result?.ok)})`);
      if (result) assert(typeof result.detail === "string" && result.detail.length > 0, "rejection needs a detail string");
      costsValid(r);
    });
  }

  // renderReport
  await c.check("renderReport", "non-empty markdown + html, no <script>, schema-valid", async (r) => {
    const audit = await services.auditTrace(r.ctx, TRACE_UNSUPPORTED_CLAIM_JSON, TRACE_SYSTEM_PROMPT);
    const report = parse(Report, await services.renderReport(r.ctx, { intake: traceIntake(TRACE_UNSUPPORTED_CLAIM_JSON), findings: audit.findings }), "renderReport");
    assert(report.markdown.trim().length > 0, "markdown is empty");
    assert(report.html.trim().length > 0, "html is empty");
    assert(!hasScript(report.html) && !hasScript(report.markdown), "report contains a <script> tag");
    assert(report.jobId === r.ctx.jobId, "report.jobId must equal ctx.jobId");
    costsValid(r);
  });

  // proposeAndVerifyFix
  await c.check("proposeAndVerifyFix", "returns schema-valid Remediation for the finding", async (r) => {
    const intake = traceIntake(TRACE_UNSUPPORTED_CLAIM_JSON);
    const audit = await services.auditTrace(r.ctx, TRACE_UNSUPPORTED_CLAIM_JSON, TRACE_SYSTEM_PROMPT);
    const finding = audit.findings.find((f) => f.status === "confirmed") ?? audit.findings[0];
    assert(finding, "no finding to fix");
    const fix = parse(Remediation, await services.proposeAndVerifyFix(r.ctx, { finding, intake }), "proposeAndVerifyFix");
    assert(fix.findingId === finding.id, `remediation.findingId ${fix.findingId} != finding.id ${finding.id}`);
    assert(fix.verification.after.total >= fix.verification.after.passed, "after.passed exceeds after.total");
    costsValid(r);
  });

  // suite path
  if (opts.skipSuite) {
    for (const n of ["designSuite", "investigate", "rerunFinding"]) c.skip(n, "suite checks", "opts.skipSuite");
  } else {
    let suite: Suite | undefined;
    await c.check("designSuite", "returns schema-valid Suite for ctx.jobId", async (r) => {
      suite = parse(Suite, await services.designSuite(r.ctx, textIntake()), "designSuite");
      assert(suite.jobId === r.ctx.jobId, "suite.jobId must equal ctx.jobId");
      assert(suite.scenarios.length >= 1, "suite has no scenarios");
      assert(new Set(suite.scenarios.map((s) => s.id)).size === suite.scenarios.length, "duplicate scenario ids");
      costsValid(r);
      return `${suite.scenarios.length} scenario(s)`;
    });
    let runs: RunResult[] = [];
    if (opts.runSuiteTarget && suite) {
      const s = suite as Suite;
      await c.check("runSuite", "results reference suite scenarios", async (r) => {
        const run = await services.runSuite(r.ctx, s, opts.runSuiteTarget!);
        const ids = new Set(s.scenarios.map((x) => x.id));
        assert(typeof run.runId === "string" && run.runId.length > 0, "runId missing");
        assert(run.results.every((x) => ids.has(x.scenarioId) && (objectivePassed(x) !== undefined || (x.assessment !== undefined && x.assessment.kind !== "objective"))), "result references unknown scenario or invalid assessment");
        runs = [run];
        costsValid(r);
      });
    } else c.skip("runSuite", "results reference suite scenarios", "no opts.runSuiteTarget (would call a live target)");
    if (suite) {
      const s = suite as Suite;
      if (runs.length === 0) runs = [{ runId: "conformance-run", versionLabel: s.versionLabel, results: s.scenarios.map((x) => ({ scenarioId: x.id, passed: false, detail: "synthetic failure for conformance" })) }];
      let found: FindingT[] = [];
      await c.check("investigate", "findings valid with evidence", async (r) => {
        found = await services.investigate(r.ctx, s, runs);
        validateFindings(found, "investigate");
        costsValid(r);
        return `${found.length} finding(s)`;
      });
      await c.check("rerunFinding", "returns schema-valid Finding with same id", async (r) => {
        const f = found[0];
        if (!f) return "no findings to rerun (skipped)";
        const out = parse(Finding, await services.rerunFinding(r.ctx, f, s.scenarios.find((x) => x.id === f.scenarioId)), "rerunFinding");
        assert(out.id === f.id, "rerunFinding must preserve finding id");
        assert(out.evidence.length >= 1, "rerun finding lost its evidence");
      });
    }
  }

  // recordCost / budget
  await c.check("budget", "ctx with budgetMicroUsd=0 throws a typed budget error or makes no paid calls", async (r) => {
    const rec = makeRecordingContext(0);
    void r;
    let threw: unknown;
    try { await services.auditTrace(rec.ctx, TRACE_UNSUPPORTED_CLAIM_JSON, TRACE_SYSTEM_PROMPT); } catch (e) { threw = e; }
    const paid = rec.costs.reduce((s, x) => s + x.microUsd, 0);
    if (threw !== undefined) {
      const name = threw instanceof Error ? `${threw.name} ${threw.message}` : String(threw);
      assert(/budget/i.test(name), `threw a non-budget error with zero budget: ${name}`);
      assert(paid === 0, `recorded ${paid} micro-USD despite zero budget`);
      return "threw budget error";
    }
    assert(paid === 0, `completed with zero budget but recorded ${paid} micro-USD of paid calls`);
    return "no paid calls";
  });

  // branching
  if (opts.skipBranching) {
    for (const n of ["createJobBranch", "deleteJobBranch", "getJobBranchConnection"]) c.skip(n, "branching", "opts.skipBranching");
  } else {
    await c.check("branching", "create -> connection -> delete", async (r) => {
      const b = parse(z.object({ branchId: z.string().min(1), connectionString: z.string().min(1) }), await services.createJobBranch(r.ctx.jobId), "createJobBranch");
      try {
        assert(typeof services.getJobBranchConnection === "function", "getJobBranchConnection must be present when createJobBranch is");
        const conn = await services.getJobBranchConnection(b.branchId);
        assert(typeof conn === "string" && conn.length > 0, "getJobBranchConnection returned empty");
      } finally { await services.deleteJobBranch(b.branchId); }
    });
  }

  return c.checks;
}

export const summarize = (checks: ConformanceCheck[]) => ({
  passed: checks.filter((x) => x.status === "pass").length,
  failed: checks.filter((x) => x.status === "fail").length,
  skipped: checks.filter((x) => x.status === "skip").length,
});

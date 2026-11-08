import { describe, expect, it, vi } from "vitest";
import { Finding, Remediation, type IntakeInput, type Scenario, type Suite } from "../contracts/index";
import type { RunResult, ServiceContext } from "../contracts/services";
import { RED_TEAM_LIBRARY } from "../redteam/library";
import { toScenario } from "../redteam/select";
import { TargetRegistry, encodeDetail, type LiteDeps } from "./deps";
import { createInvestigateServices } from "./investigate";

const JOB = "11111111-1111-4111-8111-111111111111";
const mk = (id: string, category = "factuality"): Scenario => ({ id, title: `T ${id}`, category, input: "hi", checks: [{ kind: "rubric", description: "d", spec: {} }] });
const suiteOf = (scenarios: Scenario[]): Suite => ({ jobId: JOB, versionLabel: "v", frozenAt: new Date().toISOString(), scenarios });
const ctx = (budget = 1_000_000): ServiceContext => ({ jobId: JOB, environment: "test", budgetMicroUsd: budget, recordCost: async () => {}, recordProgress: async () => {} });
const detail = (grader: "redteam" | "judge" | "error", reason = "bad answer") =>
  encodeDetail({ reason, category: "x", grader, turns: [{ role: "user", excerpt: "q" }, { role: "assistant", excerpt: "a" }] });
const res = (rs: Array<[string, boolean, string?]>): RunResult => ({ runId: "r", versionLabel: "v", results: rs.map(([scenarioId, passed, d]) => ({ scenarioId, passed, detail: d ?? detail("judge") })) });
const target = { url: "https://x.test/v1", model: "m", apiKey: "sk-secret", systemPrompt: "BASE" };

function setup(opts: { llm?: "throw" | "ok"; runSuite?: any; registered?: boolean; resolveTarget?: LiteDeps["resolveTarget"] } = {}) {
  const gen = vi.fn(async (args: any) => {
    if (opts.llm === "throw") throw new Error("llm down");
    if (args.agent === "engineer") return { object: { summary: "s", patch: "## PATCH\nbe careful", rationale: "r" } };
    const ids = [...String(args.prompt).matchAll(/scenarioId: (\S+)/g)].map((m) => m[1]);
    return { object: { findings: ids.map((scenarioId) => ({ scenarioId, title: "LLM title", category: "factual", severity: "high", description: "LLM desc" })) } };
  });
  const deps = { generateStructured: gen, generateText: vi.fn(), transport: {} as any, now: () => new Date(), resolveTarget: opts.resolveTarget } as unknown as LiteDeps;
  const registry = new TargetRegistry();
  if (opts.registered !== false) registry.remember(JOB, target);
  const runSuite = opts.runSuite ?? vi.fn(async (_c: any, s: Suite) => res(s.scenarios.map((x) => [x.id, false] as [string, boolean])));
  return { svc: createInvestigateServices(deps, registry, runSuite), runSuite, gen };
}

describe("investigate", () => {
  it("dedupes across runs, skips error grader, confirms on reproduction", async () => {
    const { svc, runSuite } = setup();
    const suite = suiteOf([mk("a"), mk("b"), mk("c")]);
    const out = await svc.investigate(ctx(), suite, [
      res([["a", false], ["b", false, detail("error", "timeout")], ["c", true]]),
      res([["a", false]]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "lf-a", status: "confirmed", reproductions: 1, scenarioId: "a", title: "LLM title" });
    expect(runSuite).toHaveBeenCalledTimes(1); // stopped early
    expect(Finding.safeParse(out[0]).success).toBe(true);
  });

  it("memory miss: resolver supplies the target for reproduction; null resolver skips re-run", async () => {
    const resolveTarget = vi.fn(async () => ({ ...target }));
    const a = setup({ registered: false, resolveTarget });
    const [f] = await a.svc.investigate(ctx(), suiteOf([mk("a")]), [res([["a", false]])]);
    expect(resolveTarget).toHaveBeenCalledWith(JOB);
    expect(a.runSuite).toHaveBeenCalled();
    expect(f.status).toBe("confirmed");
    expect(JSON.stringify(f)).not.toContain("sk-secret");

    const b = setup({ registered: false, resolveTarget: async () => null });
    const [g] = await b.svc.investigate(ctx(), suiteOf([mk("a")]), [res([["a", false]])]);
    expect(b.runSuite).not.toHaveBeenCalled();
    expect(g.status).toBe("rubric_concern");
  });

  it("does not confirm when reproduction passes", async () => {
    const runSuite = vi.fn(async (_c: any, s: Suite) => res(s.scenarios.map((x) => [x.id, true] as [string, boolean])));
    const { svc } = setup({ runSuite });
    const [f] = await svc.investigate(ctx(), suiteOf([mk("a")]), [res([["a", false]])]);
    expect(f.status).toBe("rubric_concern");
    expect(f.reproductions).toBe(0);
    expect(runSuite).toHaveBeenCalledTimes(2);
  });

  it("in-run reproductions in detail confirm without registry target or re-run", async () => {
    const { svc, runSuite } = setup({ registered: false });
    const d = encodeDetail({ reason: "r", category: "x", grader: "judge", turns: [], reproductions: 1, reproductionAttempts: 2 });
    const [f] = await svc.investigate(ctx(), suiteOf([mk("a")]), [res([["a", false, d]])]);
    expect(f).toMatchObject({ status: "confirmed", reproductions: 1 });
    expect(runSuite).not.toHaveBeenCalled();
  });

  it("does not re-run when in-run attempts already failed to reproduce (no fishing)", async () => {
    const { svc, runSuite } = setup();
    const d = encodeDetail({ reason: "r", category: "x", grader: "judge", turns: [], reproductions: 0, reproductionAttempts: 2 });
    const [f] = await svc.investigate(ctx(), suiteOf([mk("a")]), [res([["a", false, d]])]);
    expect(f).toMatchObject({ status: "rubric_concern", reproductions: 0 });
    expect(runSuite).not.toHaveBeenCalled();
  });

  it("no target -> rubric_concern, never calls runSuite", async () => {
    const { svc, runSuite } = setup({ registered: false });
    const [f] = await svc.investigate(ctx(), suiteOf([mk("a")]), [res([["a", false, detail("redteam")]])]);
    expect(f.status).toBe("rubric_concern");
    expect(runSuite).not.toHaveBeenCalled();
  });

  it("red-team finding id format and severity from metadata", async () => {
    const rt = toScenario(RED_TEAM_LIBRARY[0]);
    const { svc } = setup({ llm: "throw" });
    const [f] = await svc.investigate(ctx(), suiteOf([rt]), [res([[rt.id, false, detail("redteam", "leaked")]])]);
    expect(f.id).toBe(`rt-f-${rt.id.slice(3)}`);
    expect(f.severity).toBe(RED_TEAM_LIBRARY[0].severity);
    expect(f.status).toBe("confirmed");
  });

  it("falls back deterministically when LLM throws or budget is low", async () => {
    for (const s of [setup({ llm: "throw" }), setup()]) {
      const budget = s.gen.getMockName() && s.svc ? 0 : 0;
      const [f] = await s.svc.investigate(ctx(budget), suiteOf([mk("a", "tool_use")]), [res([["a", false]])]);
      expect(f.title).toBe("Failed: T a");
      expect(f.category).toBe("false_success");
      expect(f.severity).toBe("medium");
    }
  });
});

describe("proposeAndVerifyFix", () => {
  const intake: IntakeInput = { package: "text_eval", authorizedToTest: true, endpoint: { url: "https://x.test/v1", model: "m", systemPrompt: "BASE" } };
  const finding = Finding.parse({ id: "lf-a", title: "t", status: "confirmed", severity: "high", category: "factual", description: "d", scenarioId: "a", evidence: [{ kind: "judge", excerpt: "e" }], reproductions: 1 });
  const suite = suiteOf([mk("a"), mk("c1"), mk("c2")]);

  const fakeRun = (controlsBreak: boolean) => vi.fn(async (_c: any, s: Suite, t: any) => {
    const patched = String(t.systemPrompt).includes("## PATCH");
    return res(s.scenarios.map((x) => [x.id, x.id === "a" ? patched : !(controlsBreak && patched && x.id === "c1")] as [string, boolean]));
  });

  it("verified when failing passes after and no regressions", async () => {
    const { svc, runSuite } = setup({ runSuite: fakeRun(false) });
    const r = await svc.proposeAndVerifyFix(ctx(), { finding, suite, intake });
    expect(r.verification).toMatchObject({ status: "verified", regressions: 0, before: { passed: 2, total: 3 }, after: { passed: 3, total: 3 } });
    expect(runSuite).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(r)).not.toContain("sk-secret");
    expect(Remediation.safeParse(r).success).toBe(true);
  });

  it("not verified when the failing scenario already passes before the patch (flaky baseline)", async () => {
    const run = vi.fn(async (_c: any, sx: Suite) => res(sx.scenarios.map((x) => [x.id, true] as [string, boolean])));
    const { svc } = setup({ runSuite: run });
    const r = await svc.proposeAndVerifyFix(ctx(), { finding, suite, intake });
    expect(r.verification.status).toBe("partially_verified");
  });

  it("partially_verified on regression", async () => {
    const { svc } = setup({ runSuite: fakeRun(true) });
    const r = await svc.proposeAndVerifyFix(ctx(), { finding, suite, intake });
    expect(r.verification.status).toBe("partially_verified");
    expect(r.verification.regressions).toBe(1);
  });

  it("not_verified when patch does not help", async () => {
    const runSuite = vi.fn(async (_c: any, s: Suite) => res(s.scenarios.map((x) => [x.id, x.id !== "a"] as [string, boolean])));
    const { svc } = setup({ runSuite });
    const r = await svc.proposeAndVerifyFix(ctx(), { finding, suite, intake });
    expect(r.verification.status).toBe("not_verified");
  });

  it("trace_audit -> not_verified, no re-run, fallback patch when LLM throws", async () => {
    const { svc, runSuite } = setup({ llm: "throw" });
    const ta: IntakeInput = { package: "trace_audit", trace: "t", authorizedToTest: true };
    const f2 = Finding.parse({ ...finding, category: "false_success" });
    const r = await svc.proposeAndVerifyFix(ctx(), { finding: f2, intake: ta });
    expect(r.verification).toMatchObject({ status: "not_verified", before: { passed: 0, total: 0 }, regressions: 0 });
    expect(r.patch).toContain("tool result confirms success");
    expect(runSuite).not.toHaveBeenCalled();
    expect(Remediation.safeParse(r).success).toBe(true);
  });
});

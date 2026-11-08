import { describe, expect, it, vi } from "vitest";
import { mockServices } from "../apps/web/src/server/services";
import { runConformance, type ConformanceCheck, type ConformanceOptions } from "../packages/core/src/contracts/conformance";
import type { EvalServices } from "../packages/core/src/contracts/services";
import { createStrictConformanceServices } from "./naive-conformance-gate";

const jobId = "11111111-1111-4111-8111-111111111111";
const options: ConformanceOptions = {
  jobIdFor: () => jobId,
  runSuiteTarget: { url: "https://offline.example/v1/chat/completions", model: "offline-fixture", systemPrompt: "fixture" },
};

// Deliberately offline contract fixtures. Passing these tests proves guard behavior,
// not that a Naïve agent, target endpoint, or database was exercised.
function fixture(overrides: Partial<EvalServices> = {}): EvalServices {
  return {
    ...mockServices,
    async designSuite(ctx, intake) {
      const suite = await mockServices.designSuite(ctx, intake);
      return { ...suite, scenarios: [...suite.scenarios, { ...suite.scenarios[0], id: "second" }] };
    },
    async runSuite(_ctx, suite) {
      return { runId: "offline-run", versionLabel: suite.versionLabel,
        results: suite.scenarios.map(s => ({ scenarioId: s.id, passed: false, detail: "offline recorded failure" })) };
    },
    ...overrides,
  };
}

async function exercise(overrides: Partial<EvalServices> = {}, opts: ConformanceOptions = options) {
  const strict = createStrictConformanceServices(fixture(overrides));
  const raw = await runConformance(strict.services, opts);
  return { strict, raw, checked: strict.validate(raw) };
}
const failures = (checks: ConformanceCheck[]) => checks.filter(c => c.status === "fail");

describe("strict Naïve conformance guard (offline contract evidence only)", () => {
  it("accepts complete shared-job execution without provider or target calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected live call"));
    try {
      const { raw, checked } = await exercise();
      expect(failures(raw)).toEqual([]);
      expect(failures(checked)).toEqual([]);
      expect(checked.some(c => c.status === "skip")).toBe(false);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });

  it("accepts blocked targets rejected by throwing without network calls", async () => {
    const { raw, checked } = await exercise({ async checkTarget() { throw new Error("blocked target"); } });
    expect(failures(raw)).toEqual([]);
    expect(failures(checked)).toEqual([]);
  });

  it.each(["empty", "missing", "duplicate", "unknown", "wrong version"] as const)("rejects %s run results", async mode => {
    const base = fixture();
    const { raw, checked } = await exercise({ async runSuite(ctx, suite, target) {
      const run = await base.runSuite(ctx, suite, target);
      if (mode === "empty") run.results = [];
      if (mode === "missing") run.results = run.results.slice(0, 1);
      if (mode === "duplicate") run.results = [run.results[0], run.results[0]];
      if (mode === "unknown") run.results[1] = { ...run.results[1], scenarioId: "unknown" };
      if (mode === "wrong version") run.versionLabel = "another-version";
      return run;
    } });
    expect(raw.find(c => c.group === "runSuite")?.status).toBe("fail");
    expect(failures(checked).length).toBeGreaterThan(0);
  });

  it("rejects a suite assigned to a different job", async () => {
    const base = fixture();
    const { checked } = await exercise({ async designSuite(ctx, intake) {
      return { ...await base.designSuite(ctx, intake), jobId: "22222222-2222-4222-8222-222222222222" };
    } });
    expect(failures(checked).length).toBeGreaterThan(0);
  });

  it("rejects the harness synthetic fallback when no target run executes", async () => {
    const { raw, checked } = await exercise({}, { jobIdFor: () => jobId });
    expect(raw.some(c => c.group === "runSuite" && c.status === "skip")).toBe(true);
    expect(failures(checked).length).toBeGreaterThan(0);
  });

  it("does not count no findings to rerun as executed rerun coverage", async () => {
    const rerunFinding = vi.fn(fixture().rerunFinding);
    const { raw, checked } = await exercise({ async investigate() { return []; }, rerunFinding });
    expect(raw.find(c => c.group === "rerunFinding")?.status).toBe("pass");
    expect(rerunFinding).not.toHaveBeenCalled();
    expect(failures(checked).length).toBeGreaterThan(0);
  });

  it.each(["missing", "duplicate", "skip", "unknown"] as const)("rejects %s required check identities", async mode => {
    const { strict, raw } = await exercise();
    const required = raw.find(c => c.group === "runSuite")!;
    const altered = mode === "missing" ? raw.filter(c => c !== required)
      : mode === "duplicate" ? [...raw, { ...required }]
      : mode === "unknown" ? raw.map(c => c === required ? { ...c, name: "invented coverage" } : c)
      : raw.map(c => c === required ? { ...c, status: "skip" as const } : c);
    expect(failures(strict.validate(altered)).length).toBeGreaterThan(0);
  });

  it("rejects suite stages executed under different jobs", async () => {
    const { raw, checked } = await exercise({}, {
      ...options,
      jobIdFor: group => group === "runSuite" ? "22222222-2222-4222-8222-222222222222" : jobId,
    });
    expect(raw.find(c => c.group === "runSuite")?.status).toBe("fail");
    expect(failures(checked).length).toBeGreaterThan(0);
  });

  it("rejects skipped suite and branching paths", async () => {
    const { checked } = await exercise({}, { ...options, skipSuite: true, skipBranching: true });
    expect(failures(checked).length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import type { SandboxRunReport } from "@/components/sandbox/contract";
import { classifyChange, compareReports, filterRows, parseView } from "./run-compare";

type Check = { id: string; passed: boolean; kind?: "state" | "rubric"; detail?: string };
type TrialSpec = { passed: boolean; checks?: Check[]; attribution?: "agent" | "simulator" };

const versions = { spec: 1, suiteHash: "s1", simulatorModel: "sim", judgeModel: "judge", envHash: "e1", runtime: "openai/gpt-5-mini" };

function report(runId: string, scen: Record<string, TrialSpec[] | null>, over: Partial<SandboxRunReport> = {}): SandboxRunReport {
  const ids = Object.keys(scen);
  return {
    runId, draftId: null, name: `Agent ${runId}`, domain: "", mode: "tool_loop", status: "complete", sample: false,
    createdAt: "2026-11-08T00:00:00.000Z", k: 3, versions: versions as SandboxRunReport["versions"],
    scenarios: ids.map((id) => ({ id, title: `Scenario ${id}`, category: id.startsWith("atk") ? "injection" : "happy_path" })) as unknown as SandboxRunReport["scenarios"],
    workflows: [], policies: [], clusters: [], verifiedFix: null, media: [],
    results: ids.filter((id) => scen[id]).map((id) => ({
      scenarioId: id, workflowId: "wf", passRate: 0, reliable: false, ci95: [0, 1] as [number, number],
      trials: (scen[id] ?? []).map((t, i) => ({
        scenarioId: id, trial: i + 1, variant: "v", versions, passed: t.passed, failureAttribution: t.attribution,
        checks: (t.checks ?? []).map((c) => ({ id: c.id, kind: c.kind ?? "state", passed: c.passed, severity: "high", detail: c.detail ?? c.id })),
        transcript: [], toolCalls: [], diff: [], costMicroUsd: 10,
      })),
    })) as unknown as SandboxRunReport["results"],
    ...over,
  };
}

const pass: TrialSpec = { passed: true };
const fail = (id = "refund"): TrialSpec => ({ passed: false, checks: [{ id, passed: false }] });

describe("classifyChange", () => {
  it("labels added and removed scenarios by membership", () => {
    expect(classifyChange(null, { passed: 1, total: 1 }, false, true)).toBe("added");
    expect(classifyChange({ passed: 1, total: 1 }, null, true, false)).toBe("removed");
  });
  it("distinguishes fixed (to 100%) from improved", () => {
    expect(classifyChange({ passed: 1, total: 3 }, { passed: 3, total: 3 }, true, true)).toBe("fixed");
    expect(classifyChange({ passed: 1, total: 3 }, { passed: 2, total: 3 }, true, true)).toBe("improved");
  });
  it("flags any drop as a regression and equal rates as same", () => {
    expect(classifyChange({ passed: 3, total: 3 }, { passed: 2, total: 3 }, true, true)).toBe("regressed");
    expect(classifyChange({ passed: 2, total: 3 }, { passed: 2, total: 3 }, true, true)).toBe("same");
  });
  it("returns not_run when a side has no scored trials", () => {
    expect(classifyChange(null, { passed: 1, total: 1 }, true, true)).toBe("not_run");
  });
});

describe("compareReports", () => {
  const base = report("a", { s1: [pass, pass, pass], s2: [fail(), fail(), pass], s3: [pass, pass, pass], gone: [pass] });
  const other = report("b", { s1: [pass, fail("tone"), pass], s2: [pass, pass, pass], s3: [pass, pass, pass], fresh: [pass] });
  const cmp = compareReports(base, other);

  it("computes metric deltas in percentage points", () => {
    const k = cmp.metrics.find((m) => m.key === "passHatK");
    // base: s1,s3,gone reliable of 4 = 75%; other: s2,s3,fresh of 4 = 75%
    expect(k?.base).toBeCloseTo(0.75);
    expect(k?.other).toBeCloseTo(0.75);
    expect(k?.deltaPts).toBe(0);
    const p1 = cmp.metrics.find((m) => m.key === "passAt1");
    expect(p1?.deltaPts).toBeCloseTo(((9 / 10) - (8 / 10)) * 100, 5);
  });

  it("sorts regressions first and classifies every scenario", () => {
    expect(cmp.rows[0].scenarioId).toBe("s1");
    expect(cmp.rows[0].change).toBe("regressed");
    expect(Object.fromEntries(cmp.rows.map((r) => [r.scenarioId, r.change]))).toEqual({ s1: "regressed", s2: "fixed", s3: "same", gone: "removed", fresh: "added" });
    expect(cmp.counts).toMatchObject({ regressed: 1, fixed: 1, same: 1, added: 1, removed: 1, newFailures: 1 });
  });

  it("reports only checks that never failed in the base as new failures", () => {
    const s1 = cmp.rows.find((r) => r.scenarioId === "s1");
    expect(s1?.newFailures).toEqual([{ key: "tone", kind: "state", severity: "high", detail: "tone", trials: 1 }]);
    const s2 = cmp.rows.find((r) => r.scenarioId === "s2");
    expect(s2?.newFailures).toEqual([]);
  });

  it("excludes simulator-attributed failures from scores and new failures", () => {
    const b = report("a", { s1: [pass, pass] });
    const o = report("b", { s1: [pass, { ...fail("noise"), attribution: "simulator" }] });
    const row = compareReports(b, o).rows[0];
    expect(row.change).toBe("same");
    expect(row.newFailures).toEqual([]);
  });

  it("lists differing version fields so incomparable runs are flagged", () => {
    const o = report("b", { s1: [pass] }, { versions: { ...versions, judgeModel: "judge-2" } as SandboxRunReport["versions"] });
    expect(compareReports(report("a", { s1: [pass] }), o).versionDiffs).toEqual([{ field: "Judge model", base: "judge", other: "judge-2" }]);
    expect(cmp.versionDiffs).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const snapshot = JSON.stringify(base);
    compareReports(base, other);
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe("filterRows / parseView", () => {
  const cmp = compareReports(report("a", { s1: [pass], s2: [fail()] }), report("b", { s1: [fail("x")], s2: [pass] }));
  it("filters by view", () => {
    expect(filterRows(cmp.rows, "regressions").map((r) => r.scenarioId)).toEqual(["s1"]);
    expect(filterRows(cmp.rows, "fixed").map((r) => r.scenarioId)).toEqual(["s2"]);
    expect(filterRows(cmp.rows, "new_failures").map((r) => r.scenarioId)).toEqual(["s1"]);
    expect(filterRows(cmp.rows, "all")).toHaveLength(2);
  });
  it("falls back to all for unknown views", () => {
    expect(parseView("bogus")).toBe("all");
    expect(parseView(undefined)).toBe("all");
    expect(parseView("fixed")).toBe("fixed");
  });
});

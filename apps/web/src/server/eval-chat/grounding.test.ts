import { describe, expect, it } from "vitest";
import type { SandboxRunReport } from "@/components/sandbox/contract";
import {
  GroundingError, compareRuns, diffRows, evidence, findScenario, pickTrial, resultFor, resultsSummary, sandboxContext, sandboxSuggestions,
  stateDiff, timelineSteps, trialNumber, trialTimeline,
} from "./grounding";
import {
  FAKE_SECRET, OTHER_RUN_ID, SC_FLAKY, SC_PASS, SC_POLICY, TRANSCRIPT_MARKER, check, makeReport, scenarioResult, trial,
} from "./fixtures.testing";

describe("findScenario", () => {
  const report = makeReport();
  it("finds by exact id", () => expect(findScenario(report, SC_FLAKY).id).toBe(SC_FLAKY));
  it("finds by exact title ignoring case and punctuation", () => expect(findScenario(report, "refund WITH identity-check!").id).toBe(SC_FLAKY));
  it("finds by partial title", () => expect(findScenario(report, "past the window").id).toBe(SC_POLICY));
  it("prefers an exact title over a partial match on another scenario", () => expect(findScenario(report, "Refund a recent order").id).toBe(SC_PASS));
  it("throws a GroundingError listing every valid id for an unknown scenario", () => {
    const e = (() => { try { findScenario(report, "nope"); } catch (x) { return x; } })();
    expect(e).toBeInstanceOf(GroundingError);
    expect((e as Error).message).toContain(`${SC_PASS}, ${SC_FLAKY}, ${SC_POLICY}`);
  });
  it("does not match a blank reference to the first scenario", () => {
    expect(() => findScenario(report, "   ")).toThrow(GroundingError);
  });
});

describe("resultFor / pickTrial / trialNumber", () => {
  const report = makeReport();
  it("resultFor throws when the scenario has no finished trials", () => {
    const r = makeReport({ results: [] });
    expect(() => resultFor(r, SC_PASS)).toThrow(/no finished trials/);
  });
  it("pickTrial defaults to the first failing trial", () => {
    expect(pickTrial(resultFor(report, SC_FLAKY)).trial).toBe(1);
  });
  it("pickTrial defaults to the first trial when none failed", () => {
    expect(pickTrial(resultFor(report, SC_PASS)).trial).toBe(0);
  });
  it("trial numbers are 1-based for users when the engine stored 0-based trials", () => {
    const r = resultFor(report, SC_FLAKY);
    expect(r.trials.map((t) => trialNumber(r, t))).toEqual([1, 2]);
    expect(pickTrial(r, 1).trial).toBe(0);
    expect(pickTrial(r, 2).trial).toBe(1);
  });
  it("trial numbers pass through unchanged when trials are stored 1-based", () => {
    const r = resultFor(makeReport({}, { oneBased: true }), SC_FLAKY);
    expect(r.trials.map((t) => trialNumber(r, t))).toEqual([1, 2]);
    expect(pickTrial(r, 2).passed).toBe(false);
  });
  it("trial out of range throws a GroundingError naming the trial count", () => {
    const r = resultFor(report, SC_FLAKY);
    expect(() => pickTrial(r, 3)).toThrow(GroundingError);
    expect(() => pickTrial(r, 3)).toThrow(/ran 2 trial/);
    expect(() => pickTrial(r, 0)).toThrow(GroundingError);
  });
});

describe("evidence", () => {
  const report = makeReport();
  it("picks the first failing trial by default and reports a 1-based trial number", () => {
    const e = evidence(report, SC_FLAKY);
    expect(e).toMatchObject({ scenarioId: SC_FLAKY, trial: 2, trials: 2, passed: false, attribution: "agent", category: "boundary" });
  });
  it("honours an explicit 1-based trial (trial 1 passed)", () => {
    const e = evidence(report, SC_FLAKY, 1);
    expect(e.trial).toBe(1);
    expect(e.passed).toBe(true);
  });
  it("includes only failed checks", () => {
    const e = evidence(report, SC_FLAKY);
    expect(e.failedChecks.map((c) => c.id)).toEqual(["verify_first"]);
    expect(e.failedChecks[0]).toMatchObject({ severity: "critical", policyRef: "refund_policy:r2", passed: false });
    expect(JSON.stringify(e)).not.toContain("passing check detail");
  });
  it("resolves the scenario by title and includes the error", () => {
    const e = evidence(report, "Refund with identity check");
    expect(e.scenarioId).toBe(SC_FLAKY);
    expect(e.error).toContain("before verifying identity");
  });
  it("caps excerpt content length and keeps only the last 8 turns", () => {
    const long = Array.from({ length: 12 }, (_, i) => ({ role: "assistant" as const, content: `${i}:${"x".repeat(5_000)}` }));
    const e = evidence(makeReport({}, { failingTranscript: long }), SC_FLAKY);
    expect(e.excerpt).toHaveLength(8);
    expect(e.excerpt[0].content.startsWith("4:")).toBe(true);
    for (const l of e.excerpt) expect(l.content.length).toBeLessThanOrEqual(600);
  });
  it("caps check detail at 400 chars", () => {
    const r = makeReport();
    r.results[1].trials[1].checks = [check({ id: "big", passed: false, detail: "d".repeat(2_000) })];
    expect(evidence(r, SC_FLAKY).failedChecks[0].detail.length).toBeLessThanOrEqual(400);
  });
  it("limits failed checks to 8", () => {
    const r = makeReport();
    r.results[1].trials[1].checks = Array.from({ length: 15 }, (_, i) => check({ id: `c${i}`, passed: false }));
    expect(evidence(r, SC_FLAKY).failedChecks).toHaveLength(8);
  });
  it("a passing scenario has no failed checks and null error/attribution", () => {
    expect(evidence(report, SC_PASS)).toMatchObject({ passed: true, failedChecks: [], error: null, attribution: null });
  });
  it("unknown scenario throws a GroundingError listing valid ids", () => {
    expect(() => evidence(report, "sx_missing")).toThrow(GroundingError);
    expect(() => evidence(report, "sx_missing")).toThrow(SC_POLICY);
  });
  it("trial out of range throws a GroundingError", () => {
    expect(() => evidence(report, SC_FLAKY, 9)).toThrow(/Trial 9 does not exist/);
  });
});

describe("diffRows / stateDiff", () => {
  it("maps change kinds, stringifies object and string primary keys, and normalises non-object before/after", () => {
    const rows = diffRows([{ table: "t", inserted: 1, updated: 1, deleted: 1, sample: [
      { change: "insert", pk: { id: "a", n: 2 }, before: null, after: { id: "a" } },
      { change: "delete", pk: "b", before: { id: "b" }, after: null },
      { change: "weird", pk: 7, before: [1], after: "x" },
      { change: "update" },
    ] }]);
    expect(rows.map((r) => r.change)).toEqual(["insert", "delete", "update", "update"]);
    expect(rows.map((r) => r.pk)).toEqual(["a, 2", "b", "7", ""]);
    expect(rows[0]).toMatchObject({ table: "t", before: null, after: { id: "a" } });
    expect(rows[2]).toMatchObject({ before: null, after: null });
  });
  it("respects the row limit across tables", () => {
    const d = Array.from({ length: 3 }, (_, i) => ({ table: `t${i}`, inserted: 5, updated: 0, deleted: 0, sample: Array.from({ length: 5 }, (_, j) => ({ change: "insert", pk: j })) }));
    expect(diffRows(d, 7)).toHaveLength(7);
  });
  it("stateDiff reports per-table counts and sample rows of the first failing trial", () => {
    const c = stateDiff(makeReport(), SC_FLAKY);
    expect(c).toMatchObject({ scenarioId: SC_FLAKY, trial: 2 });
    expect(c.tables).toEqual([{ table: "refunds", inserted: 1, updated: 0, deleted: 0 }]);
    expect(c.rows).toHaveLength(2);
    expect(c.rows[0]).toMatchObject({ change: "insert", pk: "r_o_100", before: null, after: { id: "r_o_100", amount: 470 } });
  });
});

describe("timeline", () => {
  it("interleaves tool calls at tool turns and appends leftover calls, with sequential seq numbers", () => {
    const t = makeReport().results[1].trials[1];
    const steps = timelineSteps(t);
    expect(steps.map((s) => s.kind)).toEqual(["user", "tool", "assistant", "tool"]);
    expect(steps.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(steps[1]).toMatchObject({ label: "lookup_order", ms: 12 });
    expect(steps[3]).toMatchObject({ label: "refund_order", error: "boom", fault: "http_500" });
    expect(steps[0].label).toBe("Customer");
    expect(steps[2].label).toBe("Agent");
  });
  it("a tool transcript turn with no recorded call is kept as a Tool step", () => {
    const t = trial(SC_PASS, 0, { transcript: [{ role: "tool", content: "raw" }], toolCalls: [] });
    expect(timelineSteps(t)).toEqual([{ seq: 1, kind: "tool", label: "Tool", detail: "raw" }]);
  });
  it("respects the step limit", () => {
    const t = trial(SC_PASS, 0, { transcript: Array.from({ length: 100 }, () => ({ role: "user" as const, content: "x" })) });
    expect(timelineSteps(t)).toHaveLength(40);
  });
  it("trialTimeline uses the 1-based trial number", () => {
    expect(trialTimeline(makeReport(), SC_FLAKY)).toMatchObject({ scenarioId: SC_FLAKY, scenarioTitle: "Refund with identity check", trial: 2, passed: false });
    expect(trialTimeline(makeReport(), SC_FLAKY, 1).passed).toBe(true);
  });
});

describe("resultsSummary", () => {
  it("scores the run and lists per-scenario counts", () => {
    const s = resultsSummary(makeReport());
    expect(s).toMatchObject({ runId: expect.any(String), k: 2, scenarios: 3, trials: 6, costUsd: 0.06 });
    expect(s.passAt1).toBeCloseTo((1 + 0.5 + 0) / 3);
    expect(s.passHatK).toBeCloseTo(1 / 3);
    expect(s.byScenario).toEqual([
      expect.objectContaining({ id: SC_PASS, passed: 2, total: 2, reliable: true, title: "Refund a recent order" }),
      expect.objectContaining({ id: SC_FLAKY, passed: 1, total: 2, reliable: false }),
      expect.objectContaining({ id: SC_POLICY, passed: 0, total: 2, category: "policy_conflict" }),
    ]);
    expect(s.clusters).toHaveLength(1);
  });
});

describe("compareRuns", () => {
  const base = makeReport();
  const other = (() => {
    const o = makeReport({}, { runId: OTHER_RUN_ID, name: "Acme v2" });
    // SC_PASS regresses (1/2), SC_FLAKY is fixed (2/2), SC_POLICY unchanged (0/2), SC_POLICY... plus one new, minus none yet.
    o.results = [
      scenarioResult(SC_PASS, [trial(SC_PASS, 0), trial(SC_PASS, 1, { passed: false })]),
      scenarioResult(SC_FLAKY, [trial(SC_FLAKY, 0), trial(SC_FLAKY, 1)]),
      scenarioResult(SC_POLICY, [trial(SC_POLICY, 0, { passed: false }), trial(SC_POLICY, 1, { passed: false })]),
      scenarioResult("sx_added", [trial("sx_added", 0)]),
    ];
    o.scenarios = [...o.scenarios, { ...o.scenarios[0], id: "sx_added", title: "Brand new" }];
    return o;
  })();

  it("labels fixed / regressed / same / added", () => {
    const c = compareRuns(base, other);
    const by = Object.fromEntries(c.rows.map((r) => [r.scenarioId, r.change]));
    expect(by).toEqual({ [SC_PASS]: "regressed", [SC_FLAKY]: "fixed", [SC_POLICY]: "same", sx_added: "added" });
    expect(c.rows.find((r) => r.scenarioId === "sx_added")).toMatchObject({ title: "Brand new", base: null, other: { passed: 1, total: 1 } });
    expect(c.rows.find((r) => r.scenarioId === SC_FLAKY)).toMatchObject({ base: { passed: 1, total: 2 }, other: { passed: 2, total: 2 } });
  });
  it("labels scenarios that only exist in the base run as removed", () => {
    const c = compareRuns(other, base);
    expect(c.rows.find((r) => r.scenarioId === "sx_added")?.change).toBe("removed");
  });
  it("carries both run headers", () => {
    const c = compareRuns(base, other);
    expect(c.base.runId).toBe(base.runId);
    expect(c.other).toMatchObject({ runId: OTHER_RUN_ID, name: "Acme v2", k: 2 });
  });
});

describe("sandboxContext", () => {
  it("excludes transcript text and secrets, and parses as JSON", () => {
    const ctx = sandboxContext(makeReport());
    expect(ctx).not.toContain(TRANSCRIPT_MARKER);
    expect(ctx).not.toContain("Refunded $470 without checking");
    expect(ctx).not.toContain("I want my money back");
    const parsed = JSON.parse(ctx);
    expect(parsed.scenarios).toHaveLength(3);
    expect(parsed.scenarios.find((s: { id: string }) => s.id === SC_FLAKY)).toMatchObject({ result: "1/2 passed", attribution: "agent" });
    expect(parsed.scenarios[0].result).toBe("2/2 passed (reliable)");
  });
  it("is capped at 14000 characters even for huge runs", () => {
    const r = makeReport();
    const many = Array.from({ length: 200 }, (_, i) => ({ ...r.scenarios[1], id: `sx_many_${i}`, title: `Scenario ${i} ${"t".repeat(150)}` }));
    r.scenarios = many;
    r.results = many.map((s) => scenarioResult(s.id, [trial(s.id, 0, { passed: false, checks: [check({ passed: false, detail: "z".repeat(500) })] })]));
    expect(sandboxContext(r).length).toBeLessThanOrEqual(14_000);
  });
});

describe("sandboxSuggestions", () => {
  it("is specific to the run: names the first failing scenario and the policy trap", () => {
    const s = sandboxSuggestions(makeReport());
    expect(s[0]).toBe('Why did "Refund with identity check" fail?');
    expect(s.some((x) => x.includes("Refund past the window") && x.includes("fail"))).toBe(true);
    expect(s.some((x) => /Re-run the 2 failing scenarios with k=3/.test(x))).toBe(true);
    expect(s.length).toBeLessThanOrEqual(5);
  });
  it("does not suggest failure analysis when everything passed", () => {
    const r: SandboxRunReport = makeReport();
    r.results = r.results.map((x) => scenarioResult(x.scenarioId, x.trials.map((t) => ({ ...t, passed: true }))));
    const s = sandboxSuggestions(r);
    expect(s.some((x) => x.startsWith("Why did \"Refund with identity check\""))).toBe(false);
    expect(s.some((x) => /Re-run|prompt fix/.test(x))).toBe(false);
    expect(s.some((x) => x.includes("pass?"))).toBe(true);
  });
});

it("fixture secret has the shape the redactor looks for", () => {
  expect(FAKE_SECRET).toMatch(/^sk-ant-api03-[a-z0-9]{40}$/);
});

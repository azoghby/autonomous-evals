import { describe, expect, it } from "vitest";
import type { CheckResult, EvalVersions, ScenarioResult, TrialResult } from "@ae/core/sandbox/spec";
import { SANDBOX_SPEC_VERSION } from "@ae/core/sandbox/spec";
import { miniEnv, refundScenario } from "@ae/core/sandbox/engine/testing/fixtures";
import { createMemoryStore, OWNER_A } from "./memory-store.testing";
import { draftView, environmentSummary, failureClusters, runReportView } from "./views";

const versions: EvalVersions = { spec: SANDBOX_SPEC_VERSION, suiteHash: "s", simulatorModel: "sim", judgeModel: "j", envHash: "e", runtime: "r" };
const check = (id: string, severity: CheckResult["severity"], extra: Partial<CheckResult> = {}): CheckResult => ({ id, kind: "state", passed: false, severity, detail: `${id} failed`, ...extra });
const trial = (over: Partial<TrialResult>): TrialResult => ({
  scenarioId: "s1", trial: 0, variant: "base", versions, passed: false, checks: [], transcript: [], toolCalls: [], diff: [], costMicroUsd: 0, failureAttribution: "agent", ...over,
});
const result = (scenarioId: string, trials: TrialResult[]): ScenarioResult => ({ scenarioId, workflowId: "refund_request", trials, passRate: 0, reliable: false, ci95: [0, 1] });

describe("failureClusters", () => {
  it("groups trials by attribution + top failed check and counts them across scenarios", () => {
    const clusters = failureClusters([
      result("s1", [trial({ checks: [check("assert:a", "high")] }), trial({ trial: 1, checks: [check("assert:a", "high")] })]),
      result("s2", [trial({ scenarioId: "s2", checks: [check("assert:a", "high")] })]),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ trialCount: 3, attribution: "agent", severity: "high", title: "state check failed: assert:a" });
    expect(clusters[0]!.scenarioIds.sort()).toEqual(["s1", "s2"]);
  });

  it("uses the most severe failed check as the cluster key and keeps policyRef", () => {
    const [c] = failureClusters([result("s1", [trial({ checks: [check("low1", "low"), check("crit1", "critical", { policyRef: "refund_policy:r2" }), check("high1", "high")] })])]);
    expect(c).toMatchObject({ severity: "critical", policyRef: "refund_policy:r2", rootCause: "crit1 failed" });
    expect(c!.title).toContain("crit1");
  });

  it("sorts by severity then by trial count", () => {
    const clusters = failureClusters([
      result("s1", [
        trial({ checks: [check("low_many", "low")] }), trial({ trial: 1, checks: [check("low_many", "low")] }),
        trial({ trial: 2, checks: [check("high_one", "high")] }),
        trial({ trial: 3, checks: [check("crit_one", "critical")] }),
        trial({ trial: 4, checks: [check("high_two", "high")] }), trial({ trial: 5, checks: [check("high_two", "high")] }),
      ]),
    ]);
    expect(clusters.map((c) => c.title.split(": ")[1])).toEqual(["crit_one", "high_two", "high_one", "low_many"]);
  });

  it("excludes passed trials and simulator/environment-attributed failures", () => {
    const clusters = failureClusters([
      result("s1", [
        trial({ passed: true, checks: [] }),
        trial({ failureAttribution: "simulator", checks: [check("x", "critical")] }),
        trial({ failureAttribution: "environment", error: "budget_exhausted" }),
      ]),
    ]);
    expect(clusters).toEqual([]);
  });

  it("separates different attributions for the same check, and handles trials with no failed check", () => {
    const clusters = failureClusters([
      result("s1", [
        trial({ checks: [check("x", "high")] }),
        trial({ trial: 1, failureAttribution: "grader", checks: [check("x", "high")] }),
        trial({ trial: 2, failureAttribution: undefined, checks: [], error: "runtime_error: boom" }),
      ]),
    ]);
    expect(clusters).toHaveLength(3);
    const errCluster = clusters.find((c) => c.title.startsWith("Trial error"))!;
    expect(errCluster).toMatchObject({ attribution: "unknown", severity: "medium", rootCause: "runtime_error: boom" });
  });

  it("assigns sequential cluster ids", () => {
    const clusters = failureClusters([result("s1", [trial({ checks: [check("a", "high")] }), trial({ trial: 1, checks: [check("b", "low")] })])]);
    expect(clusters.map((c) => c.id).sort()).toEqual(["cl_1", "cl_2"]);
  });
});

describe("draftView / runReportView", () => {
  const setup = async () => {
    const m = createMemoryStore();
    const envRow = await m.store.insertEnvironment({ id: "env_1", ownerId: OWNER_A, name: "My Agent", domain: "support", source: "custom", spec: miniEnv, warnings: [] });
    return { m, envRow };
  };

  it("environmentSummary maps tools, tables, policies, workflows", () => {
    const s = environmentSummary(miniEnv);
    expect(s.tools.map((t) => t.name)).toContain("refund_order");
    expect(Object.keys(s.tools[0]!).sort()).toEqual(["description", "effect", "name", "source"]);
    expect(s.tables).toEqual(["orders", "refunds"]);
    expect(s.workflows[0]!.id).toBe("refund_request");
  });

  it("draftView maps suite + environment rows", async () => {
    const { m, envRow } = await setup();
    const scenarios = [{ scenario: refundScenario, decision: "pending", edited: false, validated: true, gateReasons: [] }];
    const suite = await m.store.insertSuite({ id: "drf_1", environmentId: "env_1", ownerId: OWNER_A, status: "ready", budgetMicroUsd: 1_500_000, scenarios, costMicroUsd: 42 });
    const v = draftView(suite, envRow);
    expect(v).toMatchObject({ draftId: "drf_1", environmentId: "env_1", name: "My Agent", domain: "support", mode: "tool_loop", sample: false, status: "ready", costMicroUsd: 42, createdAt: "2026-06-01T00:00:00.000Z" });
    expect(v.scenarios).toHaveLength(1);
    expect(v).not.toHaveProperty("error");
    expect(draftView({ ...suite, error: "boom" }, envRow).error).toBe("boom");
  });

  it("runReportView uses placeholder versions while pending and filters workflows to those used", async () => {
    const { m, envRow } = await setup();
    const run = await m.store.insertRun({ id: "run_1", ownerId: OWNER_A, environmentId: "env_1", suiteId: "drf_1", status: "queued", k: 3, scenarios: [refundScenario], budgetMicroUsd: 3_000_000, trialsTotal: 3 });
    const r = runReportView(run, envRow);
    expect(r.versions).toMatchObject({ suiteHash: "pending", simulatorModel: "pending", judgeModel: "pending", envHash: "pending", runtime: "pending", spec: SANDBOX_SPEC_VERSION });
    expect(r).toMatchObject({ runId: "run_1", draftId: "drf_1", status: "queued", k: 3, sample: false, verifiedFix: null, media: [], clusters: [], budgetMicroUsd: 3_000_000, progress: { trialsDone: 0, trialsTotal: 3 } });
    expect(r.workflows.map((w) => w.id)).toEqual(["refund_request"]);
    expect(r).not.toHaveProperty("completedAt");
    expect(r).not.toHaveProperty("error");
  });

  it("runReportView includes real versions, error, errorKind and completedAt when present", async () => {
    const { m, envRow } = await setup();
    const run = await m.store.insertRun({ id: "run_2", ownerId: OWNER_A, environmentId: "env_1", status: "failed", k: 1, scenarios: [], budgetMicroUsd: 1 });
    const r = runReportView({ ...run, versions, error: "bad", errorKind: "budget", completedAt: new Date("2026-06-02T00:00:00Z") }, envRow);
    expect(r.versions).toEqual(versions);
    expect(r).toMatchObject({ error: "bad", errorKind: "budget", completedAt: "2026-06-02T00:00:00.000Z" });
    expect(r.workflows).toEqual([]);
  });
});

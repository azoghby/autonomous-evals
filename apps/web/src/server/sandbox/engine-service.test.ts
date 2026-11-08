import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationMode } from "@ae/core/sandbox/spec";
import { SandboxScenario } from "@ae/core/sandbox/spec";
import { miniEnv, refundScenario } from "@ae/core/sandbox/engine/testing/fixtures";
import { SAMPLE_RUN_ID, type DraftScenario, type SandboxRunReport } from "@/components/sandbox/contract";
import {
  createEngineSandboxService, MAX_ACTIVE_RUNS, MAX_ACTIVE_SUITES, MAX_RUN_K, MAX_RUN_SCENARIOS, runBudgetMicroUsd, runStatusView, suiteBudgetMicroUsd,
  type EngineSandboxService, type SandboxExecutor,
} from "./engine-service";
import { createMemoryStore, OWNER_A, OWNER_B, type MemoryStore } from "./memory-store.testing";
import { SandboxInputError } from "./target";

const integration: IntegrationMode = { mode: "tool_loop", endpointUrl: "https://agent.example.com/v1/chat/completions", model: "m" };
const scen = (id: string) => SandboxScenario.parse({ ...refundScenario, id });
const draftScen = (id: string, over: Partial<DraftScenario> = {}): DraftScenario => ({ scenario: scen(id), decision: "pending", edited: false, validated: true, gateReasons: [], ...over });

let m: MemoryStore;
let executor: SandboxExecutor & { startSuite: ReturnType<typeof vi.fn>; startRun: ReturnType<typeof vi.fn> };
let checkTarget: ReturnType<typeof vi.fn>;
let svc: EngineSandboxService;

beforeEach(() => {
  m = createMemoryStore();
  executor = { startSuite: vi.fn(async () => "wf_suite"), startRun: vi.fn(async () => "wf_run") };
  checkTarget = vi.fn(async () => null);
  svc = createEngineSandboxService({
    store: m.store, executor, checkTarget, runBudgetMicroUsd: 3_000_000, suiteBudgetMicroUsd: 1_500_000,
    sampleReport: async () => ({ runId: SAMPLE_RUN_ID, sample: true } as unknown as SandboxRunReport),
  });
});

/** Seeds an environment + ready suite directly in the store. */
async function seedSuite(ownerId: string, scenarios: DraftScenario[], status = "ready", error: string | null = null) {
  const env = await m.store.insertEnvironment({ id: `env_${m.envs.size + 1}`, ownerId, name: "Mini", domain: "d", source: "custom", spec: miniEnv, warnings: [] });
  return m.store.insertSuite({ id: `drf_${m.suites.size + 1}`, environmentId: env.id, ownerId, status, budgetMicroUsd: 1_500_000, scenarios, error });
}

describe("env budgets", () => {
  it("runBudgetMicroUsd defaults to $3 and clamps to $25", () => {
    expect(runBudgetMicroUsd({})).toBe(3_000_000);
    expect(runBudgetMicroUsd({ SANDBOX_RUN_BUDGET_USD: "5" })).toBe(5_000_000);
    expect(runBudgetMicroUsd({ SANDBOX_RUN_BUDGET_USD: "1000" })).toBe(25_000_000);
    expect(runBudgetMicroUsd({ SANDBOX_RUN_BUDGET_USD: "abc" })).toBe(3_000_000);
    expect(runBudgetMicroUsd({ SANDBOX_RUN_BUDGET_USD: "-2" })).toBe(3_000_000);
    expect(runBudgetMicroUsd({ SANDBOX_RUN_BUDGET_USD: "0" })).toBe(3_000_000);
    expect(runBudgetMicroUsd({ SANDBOX_RUN_BUDGET_USD: "" })).toBe(3_000_000);
  });
  it("suiteBudgetMicroUsd defaults to $1.50 and clamps to $10", () => {
    expect(suiteBudgetMicroUsd({})).toBe(1_500_000);
    expect(suiteBudgetMicroUsd({ SANDBOX_SUITE_BUDGET_USD: "2.25" })).toBe(2_250_000);
    expect(suiteBudgetMicroUsd({ SANDBOX_SUITE_BUDGET_USD: "99" })).toBe(10_000_000);
    expect(suiteBudgetMicroUsd({ SANDBOX_SUITE_BUDGET_USD: "NaN" })).toBe(1_500_000);
  });
});

describe("createEnvironment / createDraft / generateSuite", () => {
  it("createEnvironment (prebuilt) saves an owner-scoped environment and returns a view", async () => {
    const v = await svc.createEnvironment(OWNER_A, { name: "My Acme", prebuilt: "acme-support", integration });
    expect(v).toMatchObject({ name: "My Acme", source: "prebuilt", prebuiltId: "acme-support" });
    expect(v.environmentId).toMatch(/^env_/);
    expect(v.tools).toBeGreaterThan(0);
    expect(m.envs.get(v.environmentId)!.ownerId).toBe(OWNER_A);
    expect(m.envs.get(v.environmentId)!.name).toBe("My Acme");
    expect(await m.store.getEnvironment(OWNER_B, v.environmentId)).toBeNull();
  });

  it("createEnvironment without prebuilt or world is a 422 on openapi", async () => {
    const e = await svc.createEnvironment(OWNER_A, { name: "x", integration }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SandboxInputError);
    expect(e).toMatchObject({ status: 422, field: "openapi" });
  });

  it("createEnvironment (custom world) works", async () => {
    const v = await svc.createEnvironment(OWNER_A, {
      name: "Shop", domain: "retail", integration,
      world: { functions: [{ name: "get_order", description: "d", parameters: { type: "object", properties: {} } }], policies: [] },
    });
    expect(v).toMatchObject({ source: "custom", prebuiltId: null, tools: 1 });
    expect(v.warnings.length).toBeGreaterThan(0);
  });

  it("rejected target URL maps to a 422 on integration.<field> and nothing is saved", async () => {
    checkTarget.mockResolvedValueOnce({ field: "endpointUrl", reason: "private address" });
    const e = await svc.createEnvironment(OWNER_A, { name: "x", prebuilt: "acme-support", integration }).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 422, field: "integration.endpointUrl" });
    expect((e as Error).message).toContain("private address");
    expect(m.envs.size).toBe(0);
  });

  it("createDraft builds env + suite in generating status with the suite budget and starts the executor", async () => {
    const d = await svc.createDraft(OWNER_A, { name: "Acme", domain: "", integration, prebuilt: "acme-support" });
    expect(d.status).toBe("generating");
    const suite = m.suites.get(d.draftId)!;
    expect(suite).toMatchObject({ ownerId: OWNER_A, budgetMicroUsd: 1_500_000, workflowRunId: "wf_suite" });
    expect(executor.startSuite).toHaveBeenCalledWith(d.draftId);
    expect(d.environmentId).toBe(suite.environmentId);
  });

  it("generateSuite: foreign or unknown environment returns null", async () => {
    const env = await m.store.insertEnvironment({ id: "env_x", ownerId: OWNER_A, name: "n", domain: "", source: "custom", spec: miniEnv, warnings: [] });
    expect(await svc.generateSuite(OWNER_B, env.id)).toBeNull();
    expect(await svc.generateSuite(OWNER_A, "env_missing")).toBeNull();
    expect(executor.startSuite).not.toHaveBeenCalled();
    const d = await svc.generateSuite(OWNER_A, env.id);
    expect(d).toMatchObject({ environmentId: "env_x", status: "generating" });
  });

  it("enforces the active-suite cap with 429", async () => {
    const env = await m.store.insertEnvironment({ id: "env_x", ownerId: OWNER_A, name: "n", domain: "", source: "custom", spec: miniEnv, warnings: [] });
    for (let i = 0; i < MAX_ACTIVE_SUITES; i++) await svc.generateSuite(OWNER_A, env.id);
    const e = await svc.generateSuite(OWNER_A, env.id).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 429 });
    // another owner is unaffected
    const envB = await m.store.insertEnvironment({ id: "env_b", ownerId: OWNER_B, name: "n", domain: "", source: "custom", spec: miniEnv, warnings: [] });
    expect(await svc.generateSuite(OWNER_B, envB.id)).not.toBeNull();
  });

  it("executor start failure marks the suite failed and rethrows", async () => {
    executor.startSuite.mockRejectedValueOnce(new Error("workflow down"));
    const env = await m.store.insertEnvironment({ id: "env_x", ownerId: OWNER_A, name: "n", domain: "", source: "custom", spec: miniEnv, warnings: [] });
    await expect(svc.generateSuite(OWNER_A, env.id)).rejects.toThrow("workflow down");
    const [suite] = [...m.suites.values()];
    expect(suite).toMatchObject({ status: "failed" });
    expect(suite!.error).toContain("Could not start");
  });

  it("an inline executor returning null does not set workflowRunId", async () => {
    executor.startSuite.mockResolvedValueOnce(null);
    const env = await m.store.insertEnvironment({ id: "env_x", ownerId: OWNER_A, name: "n", domain: "", source: "custom", spec: miniEnv, warnings: [] });
    await svc.generateSuite(OWNER_A, env.id);
    expect([...m.suites.values()][0]!.workflowRunId).toBeNull();
  });
});

describe("getDraft and owner scoping", () => {
  it("returns the draft to its owner and null to others / unknown ids", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1")]);
    expect((await svc.getDraft(OWNER_A, suite.id))?.draftId).toBe(suite.id);
    expect(await svc.getDraft(OWNER_B, suite.id)).toBeNull();
    expect(await svc.getDraft(OWNER_A, "drf_nope")).toBeNull();
  });
});

describe("reviewScenario", () => {
  it("applies a decision and persists it", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1"), draftScen("sx_2")]);
    const d = await svc.reviewScenario(OWNER_A, suite.id, "sx_1", { decision: "accepted" });
    expect(d!.scenarios.map((s) => s.decision)).toEqual(["accepted", "pending"]);
    expect((m.suites.get(suite.id)!.scenarios as DraftScenario[])[0]!.decision).toBe("accepted");
  });

  it("applies edits (title, persona goal), marking the scenario edited", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1")]);
    const d = await svc.reviewScenario(OWNER_A, suite.id, "sx_1", { decision: "accepted", edits: { title: "New title", personaGoal: "New goal" } });
    expect(d!.scenarios[0]).toMatchObject({ edited: true, scenario: { title: "New title", persona: { goal: "New goal" } } });
  });

  it("a decision without edits leaves the scenario unedited", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1")]);
    const d = await svc.reviewScenario(OWNER_A, suite.id, "sx_1", { decision: "rejected", edits: {} });
    expect(d!.scenarios[0]).toMatchObject({ edited: false, decision: "rejected" });
  });

  it("returns null for foreign owner, unknown scenario, or a suite that is not ready", async () => {
    const ready = await seedSuite(OWNER_A, [draftScen("sx_1")]);
    const generating = await seedSuite(OWNER_A, [draftScen("sx_1")], "generating");
    expect(await svc.reviewScenario(OWNER_B, ready.id, "sx_1", { decision: "accepted" })).toBeNull();
    expect(await svc.reviewScenario(OWNER_A, ready.id, "nope", { decision: "accepted" })).toBeNull();
    expect(await svc.reviewScenario(OWNER_A, generating.id, "sx_1", { decision: "accepted" })).toBeNull();
  });
});

describe("startRun", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `sx_${i + 1}`);

  it("404 for unknown or foreign draft", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1", { decision: "accepted" })]);
    expect(await svc.startRun(OWNER_B, suite.id, { k: 1 })).toMatchObject({ ok: false, status: 404 });
    expect(await svc.startRun(OWNER_A, "drf_nope", { k: 1 })).toMatchObject({ ok: false, status: 404 });
  });

  it("409 while the suite is generating / gating; 409 with the reason when it failed", async () => {
    const gen = await seedSuite(OWNER_A, [], "generating");
    const failed = await seedSuite(OWNER_A, [], "failed", "no scenarios");
    expect(await svc.startRun(OWNER_A, gen.id, { k: 1 })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("still being generated") });
    expect(await svc.startRun(OWNER_A, failed.id, { k: 1 })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("no scenarios") });
    expect(m.runs.size).toBe(0);
  });

  it("default selection is accepted scenarios only; run freezes scenarios, gates, budget and trialsTotal", async () => {
    const suite = await seedSuite(OWNER_A, [
      draftScen("sx_1", { decision: "accepted", validated: true, gateReasons: [] }),
      draftScen("sx_2", { decision: "pending" }),
      draftScen("sx_3", { decision: "accepted", validated: false, gateReasons: ["weak grader"] }),
      draftScen("sx_4", { decision: "rejected" }),
    ]);
    const r = await svc.startRun(OWNER_A, suite.id, { k: 3 });
    expect(r.ok).toBe(true);
    const run = m.runs.get((r as { runId: string }).runId)!;
    expect(run).toMatchObject({ ownerId: OWNER_A, suiteId: suite.id, status: "queued", k: 3, budgetMicroUsd: 3_000_000, trialsTotal: 6, workflowRunId: "wf_run" });
    expect((run.scenarios as SandboxScenario[]).map((s) => s.id)).toEqual(["sx_1", "sx_3"]);
    expect(run.gates).toEqual([{ scenarioId: "sx_1", validated: true, reasons: [] }, { scenarioId: "sx_3", validated: false, reasons: ["weak grader"] }]);
    expect(executor.startRun).toHaveBeenCalledWith(run.id);
  });

  it("409 when nothing is accepted", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1")]);
    expect(await svc.startRun(OWNER_A, suite.id, { k: 1 })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("Accept at least one") });
  });

  it("validatedOnly picks validated scenarios regardless of decision", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1", { validated: true }), draftScen("sx_2", { validated: false }), draftScen("sx_3", { validated: true, decision: "rejected" })]);
    const r = await svc.startRun(OWNER_A, suite.id, { k: 1, validatedOnly: true });
    const run = m.runs.get((r as { runId: string }).runId)!;
    expect((run.scenarios as SandboxScenario[]).map((s) => s.id)).toEqual(["sx_1", "sx_3"]);
  });

  it("validatedOnly with none validated is a 409 mentioning scenarioIds", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1", { validated: false })]);
    expect(await svc.startRun(OWNER_A, suite.id, { k: 1, validatedOnly: true })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("scenarioIds") });
  });

  it("explicit scenarioIds win over decisions and validatedOnly, and run unvalidated scenarios", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1", { validated: false }), draftScen("sx_2", { decision: "accepted" })]);
    const r = await svc.startRun(OWNER_A, suite.id, { k: 1, scenarioIds: ["sx_1"], validatedOnly: true });
    const run = m.runs.get((r as { runId: string }).runId)!;
    expect((run.scenarios as SandboxScenario[]).map((s) => s.id)).toEqual(["sx_1"]);
  });

  it("explicit scenarioIds with an unknown id is a 409", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1")]);
    expect(await svc.startRun(OWNER_A, suite.id, { k: 1, scenarioIds: ["sx_1", "ghost"] })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("Unknown scenario") });
  });

  it("duplicate scenarioIds are tolerated", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1")]);
    expect((await svc.startRun(OWNER_A, suite.id, { k: 1, scenarioIds: ["sx_1", "sx_1"] })).ok).toBe(true);
  });

  it("clamps k to 1..MAX_RUN_K and floors fractions", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1", { decision: "accepted" })]);
    const ks: number[] = [];
    for (const k of [0, -5, 2.9, 50]) {
      m.runs.clear();
      const r = await svc.startRun(OWNER_A, suite.id, { k });
      ks.push(m.runs.get((r as { runId: string }).runId)!.k);
    }
    expect(ks).toEqual([1, 1, 2, MAX_RUN_K]);
  });

  it("caps scenarios per run at MAX_RUN_SCENARIOS", async () => {
    const suite = await seedSuite(OWNER_A, ids(MAX_RUN_SCENARIOS + 1).map((id) => draftScen(id, { decision: "accepted" })));
    expect(await svc.startRun(OWNER_A, suite.id, { k: 1 })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining(String(MAX_RUN_SCENARIOS)) });
    const okSuite = await seedSuite(OWNER_A, ids(MAX_RUN_SCENARIOS).map((id) => draftScen(id, { decision: "accepted" })));
    expect((await svc.startRun(OWNER_A, okSuite.id, { k: 1 })).ok).toBe(true);
  });

  it("429 when the owner already has MAX_ACTIVE_RUNS runs in progress (other owners unaffected)", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1", { decision: "accepted" })]);
    for (let i = 0; i < MAX_ACTIVE_RUNS; i++) expect((await svc.startRun(OWNER_A, suite.id, { k: 1 })).ok).toBe(true);
    expect(await svc.startRun(OWNER_A, suite.id, { k: 1 })).toMatchObject({ ok: false, status: 429 });
    expect(m.runs.size).toBe(MAX_ACTIVE_RUNS);
    const suiteB = await seedSuite(OWNER_B, [draftScen("sx_1", { decision: "accepted" })]);
    expect((await svc.startRun(OWNER_B, suiteB.id, { k: 1 })).ok).toBe(true);
  });

  it("finished runs do not count toward the cap", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1", { decision: "accepted" })]);
    for (let i = 0; i < MAX_ACTIVE_RUNS; i++) await svc.startRun(OWNER_A, suite.id, { k: 1 });
    for (const r of m.runs.values()) await m.store.updateRun(r.id, { status: "complete" });
    expect((await svc.startRun(OWNER_A, suite.id, { k: 1 })).ok).toBe(true);
  });

  it("executor failure marks the run failed (retryable) and reports 409", async () => {
    executor.startRun.mockRejectedValueOnce(new Error("boom"));
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1", { decision: "accepted" })]);
    const r = await svc.startRun(OWNER_A, suite.id, { k: 1 });
    expect(r).toMatchObject({ ok: false, status: 409 });
    const run = [...m.runs.values()][0]!;
    expect(run).toMatchObject({ status: "failed", errorKind: "retryable" });
    expect(run.completedAt).toBeInstanceOf(Date);
    // a failed run no longer counts as active
    expect((await m.store.countActive(OWNER_A)).runs).toBe(0);
  });
});

describe("getRunReport", () => {
  it("delegates the sample run id to sampleReport without touching the store", async () => {
    const getRun = vi.spyOn(m.store, "getRun");
    const r = await svc.getRunReport(OWNER_A, SAMPLE_RUN_ID);
    expect(r).toMatchObject({ runId: SAMPLE_RUN_ID, sample: true });
    expect(getRun).not.toHaveBeenCalled();
  });

  it("returns an owner's run and null to others", async () => {
    const suite = await seedSuite(OWNER_A, [draftScen("sx_1", { decision: "accepted" })]);
    const r = (await svc.startRun(OWNER_A, suite.id, { k: 2 })) as { runId: string };
    expect(await svc.getRunReport(OWNER_A, r.runId)).toMatchObject({ runId: r.runId, k: 2, status: "queued" });
    expect(await svc.getRunReport(OWNER_B, r.runId)).toBeNull();
    expect(await svc.getRunReport(OWNER_A, "run_nope")).toBeNull();
  });
});

describe("misc", () => {
  it("prebuiltEnvironments lists id/name/domain", () => {
    const list = svc.prebuiltEnvironments();
    expect(list.find((e) => e.id === "acme-support")).toMatchObject({ name: "Acme Support" });
    expect(Object.keys(list[0]!).sort()).toEqual(["domain", "id", "name"]);
  });

  it("runStatusView compacts a report", () => {
    const report = { runId: "run_1", status: "running", k: 2, scenarios: [1, 2, 3], results: [1], progress: { trialsDone: 2, trialsTotal: 6 }, costMicroUsd: 500_000, budgetMicroUsd: 3_000_000 } as unknown as SandboxRunReport;
    expect(runStatusView(report)).toEqual({ runId: "run_1", status: "running", k: 2, scenariosCompleted: 1, scenariosTotal: 3, trialsCompleted: 2, trialsTotal: 6, costUsd: 0.5, budgetUsd: 3 });
    const failed = { ...report, progress: undefined, error: "x", errorKind: "fatal" } as unknown as SandboxRunReport;
    expect(runStatusView(failed)).toMatchObject({ trialsCompleted: 0, trialsTotal: 6, error: "x", errorKind: "fatal" });
  });
});

describe("plan limits (planFor)", () => {
  const NOW = new Date("2026-06-15T00:00:00Z"); // memory-store rows are created 2026-06-01, inside this month's window
  const withPlan = (plan: "developer" | "pro" | "scale" | "enterprise", now = NOW) => createEngineSandboxService({
    store: m.store, executor, checkTarget, runBudgetMicroUsd: 3_000_000, suiteBudgetMicroUsd: 1_500_000,
    sampleReport: async () => null, planFor: async () => plan, now: () => now,
  });
  const accepted = (n: number) => Array.from({ length: n }, (_, i) => draftScen(`sx_${i + 1}`, { decision: "accepted" }));
  const runIdOf = (r: unknown) => (r as { runId: string }).runId;

  it("Developer: one environment, the second is a 402; other owners unaffected", async () => {
    const s = withPlan("developer");
    await s.createEnvironment(OWNER_A, { name: "One", prebuilt: "acme-support", integration });
    await expect(s.createEnvironment(OWNER_A, { name: "Two", prebuilt: "acme-support", integration })).rejects.toMatchObject({ status: 402 });
    await expect(s.createEnvironment(OWNER_B, { name: "B", prebuilt: "acme-support", integration })).resolves.toBeTruthy();
  });

  it("Pro allows 3 environments", async () => {
    const s = withPlan("pro");
    for (const n of ["a", "b", "c"]) await s.createEnvironment(OWNER_A, { name: n, prebuilt: "acme-support", integration });
    await expect(s.createEnvironment(OWNER_A, { name: "d", prebuilt: "acme-support", integration })).rejects.toBeInstanceOf(SandboxInputError);
  });

  it("Developer: hard stop at 50 trials per month", async () => {
    const s = withPlan("developer");
    const suite = await seedSuite(OWNER_A, accepted(5));
    const first = await s.startRun(OWNER_A, suite.id, { k: 10 }); // 50 trials
    expect(first.ok).toBe(true);
    await m.store.updateRun(runIdOf(first), { status: "complete" });
    const second = await s.startRun(OWNER_A, suite.id, { k: 1 });
    expect(second).toMatchObject({ ok: false, status: 402 });
    expect((second as { error: string }).error).toMatch(/50 trials per month/);
  });

  it("failed runs only count the trials they actually ran", async () => {
    const s = withPlan("developer");
    const suite = await seedSuite(OWNER_A, accepted(5));
    const first = await s.startRun(OWNER_A, suite.id, { k: 10 });
    await m.store.updateRun(runIdOf(first), { status: "failed", trialsDone: 5 });
    expect((await s.startRun(OWNER_A, suite.id, { k: 9 })).ok).toBe(true); // 5 + 45 = 50
  });

  it("Pro runs past included trials (overage) instead of stopping", async () => {
    const s = withPlan("pro");
    const suite = await seedSuite(OWNER_A, accepted(2));
    await m.store.insertRun({ id: "run_old", ownerId: OWNER_A, environmentId: suite.environmentId, status: "complete", k: 1, scenarios: [], budgetMicroUsd: 1, trialsTotal: 2_500 });
    expect((await s.startRun(OWNER_A, suite.id, { k: 2 })).ok).toBe(true);
  });

  it("Developer: run budget shrinks to the $2/month model-spend headroom, and refuses at $0", async () => {
    const s = withPlan("developer");
    const suite = await seedSuite(OWNER_A, accepted(1));
    m.suites.set(suite.id, { ...m.suites.get(suite.id)!, costMicroUsd: 1_200_000 });
    const r = await s.startRun(OWNER_A, suite.id, { k: 1 });
    expect(m.runs.get(runIdOf(r))!.budgetMicroUsd).toBe(800_000);
    await m.store.updateRun(runIdOf(r), { status: "complete", costMicroUsd: 800_000 });
    expect(await s.startRun(OWNER_A, suite.id, { k: 1 })).toMatchObject({ ok: false, status: 402 });
  });

  it("Developer: suite generation is refused once the monthly model budget is spent", async () => {
    const s = withPlan("developer");
    const suite = await seedSuite(OWNER_A, accepted(1));
    m.suites.set(suite.id, { ...m.suites.get(suite.id)!, costMicroUsd: 2_000_000 });
    await expect(s.generateSuite(OWNER_A, suite.environmentId)).rejects.toMatchObject({ status: 402 });
  });

  it("paid plans keep the normal run budget", async () => {
    const s = withPlan("scale");
    const suite = await seedSuite(OWNER_A, accepted(1));
    m.suites.set(suite.id, { ...m.suites.get(suite.id)!, costMicroUsd: 50_000_000 });
    const r = await s.startRun(OWNER_A, suite.id, { k: 1 });
    expect(m.runs.get(runIdOf(r))!.budgetMicroUsd).toBe(3_000_000);
  });

  it("concurrent runs follow the plan: Developer 1, Scale 6", async () => {
    const dev = withPlan("developer");
    const suite = await seedSuite(OWNER_A, accepted(1));
    expect((await dev.startRun(OWNER_A, suite.id, { k: 1 })).ok).toBe(true);
    expect(await dev.startRun(OWNER_A, suite.id, { k: 1 })).toMatchObject({ ok: false, status: 429 });
    const scale = withPlan("scale");
    for (let i = 0; i < 5; i++) expect((await scale.startRun(OWNER_A, suite.id, { k: 1 })).ok).toBe(true);
    expect(await scale.startRun(OWNER_A, suite.id, { k: 1 })).toMatchObject({ ok: false, status: 429 });
  });

  it("Developer: budget reserved by an in-flight suite counts against the monthly headroom", async () => {
    const s = withPlan("developer");
    const suite = await seedSuite(OWNER_A, accepted(1));
    await m.store.insertSuite({ id: "drf_inflight", environmentId: suite.environmentId, ownerId: OWNER_A, status: "generating", budgetMicroUsd: 1_500_000 });
    const r = await s.startRun(OWNER_A, suite.id, { k: 1 });
    expect(m.runs.get(runIdOf(r))!.budgetMicroUsd).toBe(500_000); // $2 cap - $1.50 reserved
    // the in-flight run now reserves the rest: a second suite is refused rather than granted the full headroom again
    await m.store.updateRun(runIdOf(r), { status: "running" });
    await expect(s.generateSuite(OWNER_A, suite.environmentId)).rejects.toMatchObject({ status: 402 });
  });

  it("Developer: parallel starts are serialized by the owner lock (one run, not two)", async () => {
    const s = withPlan("developer");
    const suite = await seedSuite(OWNER_A, accepted(1));
    const results = await Promise.all([s.startRun(OWNER_A, suite.id, { k: 1 }), s.startRun(OWNER_A, suite.id, { k: 1 })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ status: 429 });
  });

  it("usage from a previous month does not count", async () => {
    const s = withPlan("developer", new Date("2026-07-02T00:00:00Z"));
    const suite = await seedSuite(OWNER_A, accepted(5));
    await m.store.insertRun({ id: "run_june", ownerId: OWNER_A, environmentId: suite.environmentId, status: "complete", k: 10, scenarios: [], budgetMicroUsd: 1, trialsTotal: 50 });
    expect((await s.startRun(OWNER_A, suite.id, { k: 10 })).ok).toBe(true);
  });
});

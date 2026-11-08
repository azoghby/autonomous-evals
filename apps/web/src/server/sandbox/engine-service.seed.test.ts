import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentSpec, IntegrationMode } from "@ae/core/sandbox/spec";
import { SandboxScenario } from "@ae/core/sandbox/spec";
import { miniEnv, refundScenario } from "@ae/core/sandbox/engine/testing/fixtures";
import { GATEWAY_TARGET_MODELS, GATEWAY_TARGET_URL } from "@/components/sandbox/contract";
import { MAX_ACTIVE_SUITES, createEngineSandboxService, type EngineSandboxService, type SandboxExecutor } from "./engine-service";
import { OWNER_A, OWNER_B, createMemoryStore, type MemoryStore } from "./memory-store.testing";
import { SandboxInputError } from "./target";

const scen = (id: string, over: Partial<SandboxScenario> = {}) => SandboxScenario.parse({ ...refundScenario, id, ...over });
const customerIntegration: IntegrationMode = { mode: "tool_loop", endpointUrl: "https://agent.example.com/v1/chat/completions", model: "custom-model", systemPrompt: "Customer prompt" };
const hostedIntegration: IntegrationMode = { mode: "tool_loop", endpointUrl: GATEWAY_TARGET_URL, model: "openai/gpt-5-mini", systemPrompt: "You are a support agent." };
const specWith = (integration: IntegrationMode): EnvironmentSpec => ({ ...miniEnv, integration });

type Exec = SandboxExecutor & { startSuite: ReturnType<typeof vi.fn>; startRun: ReturnType<typeof vi.fn>; startBriefScenario: ReturnType<typeof vi.fn> };
let m: MemoryStore;
let executor: Exec;
let checkTarget: ReturnType<typeof vi.fn>;
let svc: EngineSandboxService;

const build = (exec: SandboxExecutor = executor) => createEngineSandboxService({
  store: m.store, executor: exec, checkTarget, runBudgetMicroUsd: 3_000_000, suiteBudgetMicroUsd: 1_500_000, sampleReport: async () => null,
});

beforeEach(() => {
  m = createMemoryStore();
  executor = { startSuite: vi.fn(async () => "wf_suite"), startRun: vi.fn(async () => "wf_run"), startBriefScenario: vi.fn(async () => "wf_brief") };
  checkTarget = vi.fn(async () => null);
  svc = build();
});

/** An owner's environment plus a finished run over three scenarios (a, b gated ok; c rejected by the gates). */
async function seedRun(ownerId = OWNER_A, integration: IntegrationMode = customerIntegration, runId = "run_seed") {
  const env = await m.store.insertEnvironment({ id: `env_${m.envs.size + 1}`, ownerId, name: "Acme agent", domain: "support", source: "custom", spec: specWith(integration), warnings: [] });
  const scenarios = [scen("sx_a", { oracleValidated: false }), scen("sx_b", { oracleValidated: true }), scen("sx_c", { oracleValidated: true })];
  const run = await m.store.insertRun({
    id: runId, ownerId, environmentId: env.id, suiteId: null, status: "complete", k: 2, scenarios, budgetMicroUsd: 1, trialsTotal: 6,
    gates: [{ scenarioId: "sx_a", validated: true, reasons: [] }, { scenarioId: "sx_c", validated: false, reasons: ["oracle could not solve it"] }],
  });
  return { env, run, scenarios };
}

describe("seedSuiteFromRun: ownership", () => {
  it("returns null for another owner's run and for an unknown run, creating nothing", async () => {
    const { run } = await seedRun(OWNER_A);
    expect(await svc.seedSuiteFromRun(OWNER_B, run.id, {})).toBeNull();
    expect(await svc.seedSuiteFromRun(OWNER_A, "run_missing", {})).toBeNull();
    expect(await svc.seedSuiteFromRun(OWNER_B, run.id, { brief: { brief: "x".repeat(20), category: "boundary" } })).toBeNull();
    expect(m.suites.size).toBe(0);
    expect(m.envs.size).toBe(1);
    expect(executor.startBriefScenario).not.toHaveBeenCalled();
  });
  it("returns null when the run's environment is gone", async () => {
    const { run, env } = await seedRun();
    m.envs.delete(env.id);
    expect(await svc.seedSuiteFromRun(OWNER_A, run.id, {})).toBeNull();
  });
});

describe("seedSuiteFromRun: without a brief", () => {
  it("creates a ready suite holding the run's scenarios with gate verdicts carried over", async () => {
    const { run, env } = await seedRun();
    const draft = await svc.seedSuiteFromRun(OWNER_A, run.id, {});
    expect(draft).toMatchObject({ status: "ready", environmentId: env.id, sample: false, name: "Acme agent" });
    expect(draft!.scenarios.map((d) => d.scenario.id)).toEqual(["sx_a", "sx_b", "sx_c"]);
    // recorded gate verdicts win over the scenario's own flag; a scenario with no recorded gate falls back to oracleValidated.
    expect(draft!.scenarios.map((d) => d.validated)).toEqual([true, true, false]);
    expect(draft!.scenarios[2].gateReasons).toEqual(["oracle could not solve it"]);
    expect(draft!.scenarios.every((d) => d.decision === "accepted" && !d.edited)).toBe(true);
    const suite = m.suites.get(draft!.draftId)!;
    expect(suite).toMatchObject({ ownerId: OWNER_A, status: "ready", environmentId: env.id });
  });
  it("starts no workflow and reuses the run's environment", async () => {
    const { run } = await seedRun();
    await svc.seedSuiteFromRun(OWNER_A, run.id, {});
    expect(executor.startSuite).not.toHaveBeenCalled();
    expect(executor.startBriefScenario).not.toHaveBeenCalled();
    expect(m.envs.size).toBe(1);
  });
  it("drops removeScenarioIds and ignores unknown ids", async () => {
    const { run } = await seedRun();
    const draft = await svc.seedSuiteFromRun(OWNER_A, run.id, { removeScenarioIds: ["sx_b", "sx_nope"] });
    expect(draft!.scenarios.map((d) => d.scenario.id)).toEqual(["sx_a", "sx_c"]);
  });
  it("removing every scenario is a 409 SandboxInputError and no suite is created", async () => {
    const { run } = await seedRun();
    const err = await svc.seedSuiteFromRun(OWNER_A, run.id, { removeScenarioIds: ["sx_a", "sx_b", "sx_c"] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxInputError);
    expect(err).toMatchObject({ status: 409 });
    expect(m.suites.size).toBe(0);
  });
  it("the seeded suite is immediately runnable through startRun", async () => {
    const { run } = await seedRun();
    const draft = await svc.seedSuiteFromRun(OWNER_A, run.id, { removeScenarioIds: ["sx_c"] });
    const res = await svc.startRun(OWNER_A, draft!.draftId, { k: 2, scenarioIds: ["sx_a"] });
    expect(res.ok).toBe(true);
    expect(executor.startRun).toHaveBeenCalledTimes(1);
  });
  it("the seeded suite belongs to the owner only", async () => {
    const { run } = await seedRun();
    const draft = await svc.seedSuiteFromRun(OWNER_A, run.id, {});
    expect(await svc.getDraft(OWNER_B, draft!.draftId)).toBeNull();
  });
});

describe("seedSuiteFromRun: with a brief", () => {
  const brief = { brief: "Customer asks for a refund over the limit", category: "boundary" as const };
  it("calls executor.startBriefScenario with the suite id and request; the suite starts generating with the base scenarios seeded", async () => {
    const { run } = await seedRun();
    const draft = await svc.seedSuiteFromRun(OWNER_A, run.id, { brief });
    expect(draft).toMatchObject({ status: "generating" });
    expect(executor.startBriefScenario).toHaveBeenCalledWith(draft!.draftId, brief);
    expect(executor.startSuite).not.toHaveBeenCalled();
    const suite = m.suites.get(draft!.draftId)!;
    expect(suite).toMatchObject({ status: "generating", ownerId: OWNER_A, workflowRunId: "wf_brief", budgetMicroUsd: 1_500_000 });
    expect(draft!.scenarios.map((d) => d.scenario.id)).toEqual(["sx_a", "sx_b", "sx_c"]);
  });
  it("honours removeScenarioIds alongside the brief (replace flow)", async () => {
    const { run } = await seedRun();
    const draft = await svc.seedSuiteFromRun(OWNER_A, run.id, { brief, removeScenarioIds: ["sx_b"] });
    expect(draft!.scenarios.map((d) => d.scenario.id)).toEqual(["sx_a", "sx_c"]);
  });
  it("removing every scenario is allowed when a new one is being generated", async () => {
    const { run } = await seedRun();
    const draft = await svc.seedSuiteFromRun(OWNER_A, run.id, { brief, removeScenarioIds: ["sx_a", "sx_b", "sx_c"] });
    expect(draft).toMatchObject({ status: "generating", scenarios: [] });
  });
  it("an executor without startBriefScenario is a 409 and no suite is left behind", async () => {
    const { run } = await seedRun();
    const bare = build({ startSuite: executor.startSuite, startRun: executor.startRun });
    await expect(bare.seedSuiteFromRun(OWNER_A, run.id, { brief })).rejects.toMatchObject({ status: 409 });
    expect(m.suites.size).toBe(0);
  });
  it("respects the active-suite cap with 429", async () => {
    const { run } = await seedRun();
    for (let i = 0; i < MAX_ACTIVE_SUITES; i++) await svc.seedSuiteFromRun(OWNER_A, run.id, { brief });
    await expect(svc.seedSuiteFromRun(OWNER_A, run.id, { brief })).rejects.toMatchObject({ status: 429 });
  });
  it("a workflow start failure marks the suite failed and rethrows", async () => {
    executor.startBriefScenario.mockRejectedValueOnce(new Error("workflow down"));
    const { run } = await seedRun();
    await expect(svc.seedSuiteFromRun(OWNER_A, run.id, { brief })).rejects.toThrow("workflow down");
    expect([...m.suites.values()][0]).toMatchObject({ status: "failed" });
  });
});

describe("seedSuiteFromRun: changing the target", () => {
  it("a model outside GATEWAY_TARGET_MODELS on a hosted target is a 422 SandboxInputError naming the allowed models", async () => {
    const { run } = await seedRun(OWNER_A, hostedIntegration);
    const err = await svc.seedSuiteFromRun(OWNER_A, run.id, { target: { model: "openai/gpt-9-ultra" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxInputError);
    expect(err).toMatchObject({ status: 422, field: "integration.model" });
    for (const model of GATEWAY_TARGET_MODELS) expect((err as Error).message).toContain(model);
    expect(m.envs.size).toBe(1);
    expect(m.suites.size).toBe(0);
  });
  it("an allowlisted model creates a sibling environment and leaves the original untouched", async () => {
    const { run, env } = await seedRun(OWNER_A, hostedIntegration);
    const draft = await svc.seedSuiteFromRun(OWNER_A, run.id, { target: { model: "openai/gpt-5-nano" }, removeScenarioIds: ["sx_c"] });
    expect(m.envs.size).toBe(2);
    const sibling = m.envs.get(draft!.environmentId!)!;
    expect(sibling.id).not.toBe(env.id);
    expect(sibling.name).toBe(`${(env.spec as EnvironmentSpec).name} (openai/gpt-5-nano)`);
    expect((sibling.spec as EnvironmentSpec).integration).toMatchObject({ mode: "tool_loop", endpointUrl: GATEWAY_TARGET_URL, model: "openai/gpt-5-nano", systemPrompt: "You are a support agent." });
    expect(((m.envs.get(env.id)!.spec) as EnvironmentSpec).integration).toMatchObject({ model: "openai/gpt-5-mini" });
    expect(draft!.scenarios.map((d) => d.scenario.id)).toEqual(["sx_a", "sx_b"]);
    expect(sibling.ownerId).toBe(OWNER_A);
  });
  it("a new system prompt is applied (truncated to 50k) and the new integration is checked for SSRF", async () => {
    const { run } = await seedRun(OWNER_A, hostedIntegration);
    const draft = await svc.seedSuiteFromRun(OWNER_A, run.id, { target: { systemPrompt: "p".repeat(60_000) } });
    const integ = (m.envs.get(draft!.environmentId!)!.spec as EnvironmentSpec).integration as Extract<IntegrationMode, { mode: "tool_loop" }>;
    expect(integ.systemPrompt).toHaveLength(50_000);
    expect(integ.model).toBe("openai/gpt-5-mini");
    expect(checkTarget).toHaveBeenCalledWith(expect.objectContaining({ endpointUrl: GATEWAY_TARGET_URL }));
    expect(m.envs.get(draft!.environmentId!)!.name).toContain("new prompt");
  });
  it("a rejected target URL aborts with a 422 before anything is saved", async () => {
    checkTarget.mockResolvedValueOnce({ field: "endpointUrl", reason: "private address" });
    const { run } = await seedRun(OWNER_A, hostedIntegration);
    await expect(svc.seedSuiteFromRun(OWNER_A, run.id, { target: { model: "openai/gpt-5-nano" } })).rejects.toMatchObject({ status: 422, field: "integration.endpointUrl" });
    expect(m.envs.size).toBe(1);
  });
  it("an empty target changes nothing", async () => {
    const { run, env } = await seedRun(OWNER_A, hostedIntegration);
    const draft = await svc.seedSuiteFromRun(OWNER_A, run.id, { target: {} });
    expect(draft!.environmentId).toBe(env.id);
    expect(m.envs.size).toBe(1);
  });
  it("a non-tool_loop integration with a target change is a 422 on integration", async () => {
    const { run } = await seedRun(OWNER_A, { mode: "sandbox_api", chatEndpointUrl: "https://agent.example.com/chat" });
    const err = await svc.seedSuiteFromRun(OWNER_A, run.id, { target: { model: "x" } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxInputError);
    expect(err).toMatchObject({ status: 422, field: "integration" });
    expect(m.envs.size).toBe(1);
  });
  it("a customer endpoint (not hosted) may use any model string: the allowlist guards only the hosted gateway", async () => {
    const { run } = await seedRun(OWNER_A, customerIntegration);
    const draft = await svc.seedSuiteFromRun(OWNER_A, run.id, { target: { model: "my-own-model" } });
    expect((m.envs.get(draft!.environmentId!)!.spec as EnvironmentSpec).integration).toMatchObject({ model: "my-own-model" });
  });
});

describe("getRunTarget", () => {
  it("detects the hosted gateway target by endpoint URL and reports model and prompt", async () => {
    const { run } = await seedRun(OWNER_A, hostedIntegration);
    expect(await svc.getRunTarget(OWNER_A, run.id)).toEqual({ mode: "tool_loop", hosted: true, model: "openai/gpt-5-mini", systemPrompt: "You are a support agent." });
  });
  it("a customer endpoint is not hosted", async () => {
    const { run } = await seedRun(OWNER_A, customerIntegration);
    expect(await svc.getRunTarget(OWNER_A, run.id)).toMatchObject({ mode: "tool_loop", hosted: false, model: "custom-model" });
  });
  it("hosted detection is exact: a look-alike URL on the gateway host or a different path is not hosted", async () => {
    const { run } = await seedRun(OWNER_A, { mode: "tool_loop", endpointUrl: `${GATEWAY_TARGET_URL}/../evil`, model: "m" });
    expect((await svc.getRunTarget(OWNER_A, run.id))!.hosted).toBe(false);
    const { run: r2 } = await seedRun(OWNER_A, { mode: "tool_loop", endpointUrl: "https://ai-gateway.vercel.sh.evil.example/v1/chat/completions", model: "m" }, "run_seed2");
    expect((await svc.getRunTarget(OWNER_A, r2.id))!.hosted).toBe(false);
  });
  it("non tool_loop integrations report their mode, never hosted, with no model or prompt", async () => {
    const { run } = await seedRun(OWNER_A, { mode: "staging", chatEndpointUrl: "https://staging.example.com/chat" });
    expect(await svc.getRunTarget(OWNER_A, run.id)).toEqual({ mode: "staging", hosted: false });
  });
  it("is null for another owner's run and unknown runs", async () => {
    const { run } = await seedRun(OWNER_A, hostedIntegration);
    expect(await svc.getRunTarget(OWNER_B, run.id)).toBeNull();
    expect(await svc.getRunTarget(OWNER_A, "run_missing")).toBeNull();
  });
});

describe("listRuns", () => {
  it("lists only the owner's runs, newest first, with names from the environment", async () => {
    await seedRun(OWNER_A, customerIntegration, "run_one");
    await seedRun(OWNER_B, customerIntegration, "run_theirs");
    const runs = await svc.listRuns(OWNER_A);
    expect(runs.map((r) => r.runId)).toEqual(["run_one"]);
    expect(runs[0]).toMatchObject({ name: "Acme agent", k: 2, scenarios: 3, status: "complete" });
  });
  it("clamps the limit to 1..50 and defaults to 20", async () => {
    const spy = vi.spyOn(m.store, "listRuns");
    await svc.listRuns(OWNER_A);
    await svc.listRuns(OWNER_A, 0);
    await svc.listRuns(OWNER_A, 999);
    expect(spy.mock.calls.map((c) => c[1])).toEqual([20, 1, 50]);
  });
});

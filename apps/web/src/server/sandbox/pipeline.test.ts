import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@ae/core/db/client", () => ({ db: () => { throw new Error("no DB in unit tests"); }, schema: {} }));
vi.mock("@ae/core/sandbox/engine/generate", () => ({ generateScenarios: vi.fn() }));
vi.mock("@ae/core/sandbox/engine/gates", async (orig) => ({ ...(await orig<typeof import("@ae/core/sandbox/engine/gates")>()), gateSuite: vi.fn() }));

import { gateSuite } from "@ae/core/sandbox/engine/gates";
import { generateScenarios } from "@ae/core/sandbox/engine/generate";
import { FakeRuntime } from "@ae/core/sandbox/engine/testing/fake-runtime";
import { fakeGateway, type FakeCall } from "@ae/core/sandbox/engine/testing/fake-gateway";
import { miniEnv, miniWorld, refundScenario } from "@ae/core/sandbox/engine/testing/fixtures";
import { wilsonInterval } from "@ae/core/sandbox/engine/util";
import { SandboxScenario, type EnvironmentSpec, type ScenarioResult } from "@ae/core/sandbox/spec";
import type { JsonTransport } from "@ae/core/targets/transport";
import type { GeneratedScenario } from "@ae/core/sandbox/engine/types";
import { createMemoryStore, OWNER_A, type MemoryStore } from "./memory-store.testing";
import {
  failRun, failSuite, finalizeRun, GENERATION_SHARE, generateSuiteScenarios, gateSuiteScenarios, prepareRunWorld, runRunInline, runScenarioTrials,
  runSuiteInline, runVersions, SandboxFatalError, teardownRunWorld, type PipelineDeps,
} from "./pipeline";
import { GATEWAY_CHAT_URL } from "./target";

const scen = (id: string, over: Record<string, unknown> = {}) => SandboxScenario.parse({ ...refundScenario, id, ...over });
const S1 = scen("sx_one");
const S2 = scen("sx_two");
const generatedOf = (s: SandboxScenario): GeneratedScenario => ({ scenario: s, mutations: [], slot: { workflowId: "refund_request", category: s.category, impossible: false, index: 0 } });

/** OpenAI-chat-completions fake: a correct agent (verify -> lookup -> refund -> confirm), driven by how many tool results it has seen. */
function refundTransport(opts: { usage?: Record<string, number> } = {}): JsonTransport & { posts: number } {
  const t = {
    posts: 0,
    async post(_endpoint: string, body: unknown) {
      t.posts++;
      const messages = (body as { messages: Array<{ role: string }> }).messages;
      const seen = messages.filter((m) => m.role === "tool").length;
      const call = (name: string, args: unknown) => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: `c${seen}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], ...(opts.usage ? { usage: opts.usage } : {}) });
      if (seen === 0) return call("verify_identity", { customer_id: "c_1", email: "ann@example.com" });
      if (seen === 1) return call("lookup_order", { order_id: "o_100" });
      if (seen === 2) return call("refund_order", { order_id: "o_100", amount: 47.2 });
      return { choices: [{ message: { role: "assistant", content: "Done: your refund of $47.20 for order o_100 has been issued." }, finish_reason: "stop" }] };
    },
  };
  return t;
}

/** Gateway handler for the simulator (operator), judge and attribution calls. */
const gatewayHandler = (call: FakeCall): unknown => {
  if (call.agent === "operator") return { message: "Please refund order o_100. My customer id is c_1 and email ann@example.com.", status: "goal_achieved" };
  return { items: [{ id: "tone", passed: true, reason: "ok" }], communicated: true, refused: false, reason: "ok", simulatorError: false, kinds: [] };
};

let m: MemoryStore;
let rt: FakeRuntime;
let deps: PipelineDeps;
let transport: ReturnType<typeof refundTransport>;
let gwCalls: FakeCall[];

function makeDeps(over: Partial<PipelineDeps> = {}, handler = gatewayHandler, microUsdPerCall = 100): PipelineDeps {
  const gw = fakeGateway(handler, { microUsdPerCall });
  gwCalls = gw.calls;
  return { store: m.store, gateway: gw, runtime: () => rt, transport: () => transport, concurrency: 1, ...over };
}

beforeEach(() => {
  vi.mocked(generateScenarios).mockReset();
  vi.mocked(gateSuite).mockReset();
  m = createMemoryStore();
  rt = new FakeRuntime(miniWorld);
  transport = refundTransport();
  deps = makeDeps();
});

async function seedEnv(spec: EnvironmentSpec = miniEnv) {
  return m.store.insertEnvironment({ id: "env_1", ownerId: OWNER_A, name: "Mini", domain: "d", source: "custom", spec, warnings: [] });
}
async function seedSuite(over: Record<string, unknown> = {}) {
  await seedEnv();
  return m.store.insertSuite({ id: "drf_00000000-1111-2222-3333-444444444444", environmentId: "env_1", ownerId: OWNER_A, status: "generating", budgetMicroUsd: 1_000_000, ...over });
}
async function seedRun(over: Record<string, unknown> = {}, spec: EnvironmentSpec = miniEnv) {
  await seedEnv(spec);
  const scenarios = (over.scenarios as SandboxScenario[] | undefined) ?? [S1, S2];
  const k = (over.k as number | undefined) ?? 2;
  return m.store.insertRun({ id: "run_00000000-1111-2222-3333-444444444444", ownerId: OWNER_A, environmentId: "env_1", status: "queued", k, scenarios, budgetMicroUsd: 3_000_000, trialsTotal: scenarios.length * k, ...over });
}
const getRun = (id: string) => m.runs.get(id)!;

/* ---------------- suite ---------------- */

describe("generateSuiteScenarios", () => {
  it("generates one scenario per category, stores them, and moves the suite to gating", async () => {
    const suite = await seedSuite();
    vi.mocked(generateScenarios).mockImplementation(async (_env, _deps, req) => ({ scenarios: [generatedOf(scen(`sx_${req.categories![0]}`))], failures: [] }) as never);
    const out = await generateSuiteScenarios(deps, suite.id);
    expect(out).toEqual({ generated: 4, failures: [] });
    const cats = vi.mocked(generateScenarios).mock.calls.map((c) => c[2].categories![0]).sort();
    expect(cats).toEqual(["boundary", "happy_path", "injection", "policy_conflict"]);
    expect(m.suites.get(suite.id)).toMatchObject({ status: "gating" });
    expect(m.suites.get(suite.id)!.generated).toHaveLength(4);
  });

  it("caps generation at GENERATION_SHARE of the suite budget, minus what is already spent", async () => {
    const suite = await seedSuite({ budgetMicroUsd: 1_000_000, costMicroUsd: 100_000 });
    let seen = -1;
    vi.mocked(generateScenarios).mockImplementation(async (_e, d) => { seen = d.ctx.budgetMicroUsd ?? -1; return { scenarios: [generatedOf(S1)], failures: [] } as never; });
    await generateSuiteScenarios(deps, suite.id);
    expect(GENERATION_SHARE).toBe(0.6);
    expect(seen).toBe(600_000 - 100_000);
  });

  it("generation spend is recorded against the suite", async () => {
    const suite = await seedSuite();
    vi.mocked(generateScenarios).mockImplementation(async (_e, d) => { await d.ctx.recordCost({ source: "ai_gateway", microUsd: 250 }); return { scenarios: [generatedOf(S1)], failures: [] } as never; });
    await generateSuiteScenarios(deps, suite.id);
    expect(m.suites.get(suite.id)!.costMicroUsd).toBe(1_000);
    expect(m.costs.every((c) => c.kind === "suite")).toBe(true);
  });

  it("is idempotent: a suite no longer generating is left alone", async () => {
    const suite = await seedSuite({ status: "gating", generated: [generatedOf(S1), generatedOf(S2)] });
    expect(await generateSuiteScenarios(deps, suite.id)).toEqual({ generated: 2, failures: [] });
    expect(generateScenarios).not.toHaveBeenCalled();
  });

  it("partial failures still succeed and are reported", async () => {
    const suite = await seedSuite();
    vi.mocked(generateScenarios).mockImplementation(async (_e, _d, req) =>
      (req.categories![0] === "injection"
        ? { scenarios: [], failures: [{ slot: { category: "injection" }, error: "bad json" }] }
        : { scenarios: [generatedOf(scen(`sx_${req.categories![0]}`))], failures: [] }) as never);
    const out = await generateSuiteScenarios(deps, suite.id);
    expect(out.generated).toBe(3);
    expect(out.failures).toEqual(["injection: bad json"]);
  });

  it("nothing generated -> SandboxFatalError(fatal) with the failure reasons", async () => {
    const suite = await seedSuite();
    vi.mocked(generateScenarios).mockResolvedValue({ scenarios: [], failures: [{ slot: { category: "boundary" }, error: "nope" }] } as never);
    const e = await generateSuiteScenarios(deps, suite.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SandboxFatalError);
    expect(e).toMatchObject({ kind: "fatal" });
    expect((e as Error).message).toContain("boundary: nope");
    expect(m.suites.get(suite.id)!.status).toBe("generating");
  });

  it("nothing generated with the generation budget spent -> kind budget", async () => {
    const suite = await seedSuite({ budgetMicroUsd: 1_000_000, costMicroUsd: 600_000 });
    vi.mocked(generateScenarios).mockResolvedValue({ scenarios: [], failures: [] } as never);
    await expect(generateSuiteScenarios(deps, suite.id)).rejects.toMatchObject({ kind: "budget" });
  });

  it("unknown suite / environment are fatal", async () => {
    await expect(generateSuiteScenarios(deps, "drf_missing")).rejects.toBeInstanceOf(SandboxFatalError);
    await m.store.insertSuite({ id: "drf_orphan", environmentId: "env_gone", ownerId: OWNER_A, status: "generating", budgetMicroUsd: 1 });
    await expect(generateSuiteScenarios(deps, "drf_orphan")).rejects.toThrow("Environment env_gone not found");
  });
});

describe("gateSuiteScenarios", () => {
  it("maps gate reports onto reviewable scenarios and makes the suite ready", async () => {
    const suite = await seedSuite({ status: "gating", generated: [generatedOf(S1), generatedOf(S2)] });
    vi.mocked(gateSuite).mockResolvedValue({
      accepted: [S1],
      reports: [
        { scenarioId: S1.id, accepted: true, reasons: [] },
        { scenarioId: S2.id, accepted: false, reasons: ["oracle failed", "r2", "r3", "r4", "r5", "r6", "r7", "r8"] },
      ],
    } as never);
    expect(await gateSuiteScenarios(deps, suite.id)).toEqual({ accepted: 1, total: 2 });
    const stored = m.suites.get(suite.id)!;
    expect(stored.status).toBe("ready");
    const [a, b] = stored.scenarios as Array<{ scenario: SandboxScenario; decision: string; validated: boolean; gateReasons: string[]; edited: boolean }>;
    expect(a).toMatchObject({ decision: "pending", edited: false, validated: true, gateReasons: [] });
    expect(a!.scenario.oracleValidated).toBe(true);
    expect(b).toMatchObject({ validated: false });
    expect(b!.scenario.oracleValidated).toBe(false);
    expect(b!.gateReasons).toHaveLength(6);
  });

  it("scenarios without a report are marked unvalidated 'not gated'", async () => {
    const suite = await seedSuite({ status: "gating", generated: [generatedOf(S1)] });
    vi.mocked(gateSuite).mockResolvedValue({ accepted: [], reports: [] } as never);
    await gateSuiteScenarios(deps, suite.id);
    expect((m.suites.get(suite.id)!.scenarios as Array<{ gateReasons: string[] }>)[0]!.gateReasons).toEqual(["not gated"]);
  });

  it("gating sees the budget remaining after generation, and uses a g_ job id", async () => {
    const suite = await seedSuite({ status: "gating", generated: [generatedOf(S1)], costMicroUsd: 450_000 });
    let budget = -1;
    vi.mocked(gateSuite).mockImplementation(async (_env, _gen, _rt, d) => { budget = d.ctx.budgetMicroUsd ?? -1; return { accepted: [], reports: [] } as never; });
    await gateSuiteScenarios(deps, suite.id);
    expect(budget).toBe(550_000);
    expect(vi.mocked(gateSuite).mock.calls[0]![4].jobId).toMatch(/^g_[a-z0-9]{1,12}$/);
  });

  it("is idempotent for an already-ready suite", async () => {
    const suite = await seedSuite({ status: "ready", generated: [generatedOf(S1), generatedOf(S2)], scenarios: [{ scenario: S1, decision: "pending", edited: false, validated: true }, { scenario: S2, decision: "pending", edited: false, validated: false }] });
    expect(await gateSuiteScenarios(deps, suite.id)).toEqual({ accepted: 1, total: 2 });
    expect(gateSuite).not.toHaveBeenCalled();
  });
});

describe("runSuiteInline / failSuite", () => {
  it("generates then gates", async () => {
    const suite = await seedSuite();
    vi.mocked(generateScenarios).mockResolvedValue({ scenarios: [generatedOf(S1)], failures: [] } as never);
    vi.mocked(gateSuite).mockResolvedValue({ accepted: [S1], reports: [{ scenarioId: S1.id, accepted: true, reasons: [] }] } as never);
    await runSuiteInline(deps, suite.id);
    expect(m.suites.get(suite.id)!.status).toBe("ready");
  });

  it("marks the suite failed when a step throws", async () => {
    const suite = await seedSuite();
    vi.mocked(generateScenarios).mockResolvedValue({ scenarios: [], failures: [] } as never);
    await runSuiteInline(deps, suite.id);
    expect(m.suites.get(suite.id)).toMatchObject({ status: "failed" });
    expect(m.suites.get(suite.id)!.error).toContain("Scenario generation failed");
  });

  it("failSuite truncates the message", async () => {
    const suite = await seedSuite();
    await failSuite(deps, suite.id, "x".repeat(5_000));
    expect(m.suites.get(suite.id)!.error).toHaveLength(1_000);
  });
});

/* ---------------- run ---------------- */

describe("prepareRunWorld", () => {
  it("marks the run running, pins versions, prepares the world once and stores worldId", async () => {
    const run = await seedRun();
    const { worldId } = await prepareRunWorld(deps, run.id);
    expect(worldId).toMatch(/^world_r_/);
    expect(getRun(run.id)).toMatchObject({ status: "running", worldId });
    expect(getRun(run.id).startedAt).toBeInstanceOf(Date);
    expect(getRun(run.id).versions).toEqual(runVersions(miniEnv, [S1, S2]));
    expect(rt.prepared).toEqual([worldId]);
  });

  it("is idempotent: an existing worldId short-circuits without touching the runtime", async () => {
    const run = await seedRun({ worldId: "world_existing" });
    expect(await prepareRunWorld(deps, run.id)).toEqual({ worldId: "world_existing" });
    expect(rt.prepared).toEqual([]);
    expect(getRun(run.id).status).toBe("queued");
  });

  it("an unrunnable target is fatal and nothing is prepared", async () => {
    const gatewayEnv = { ...miniEnv, integration: { mode: "tool_loop", endpointUrl: GATEWAY_CHAT_URL, model: "openai/gpt-5-mini" } } as EnvironmentSpec;
    const run = await seedRun({}, gatewayEnv);
    const e = await prepareRunWorld({ ...deps, gatewayKey: undefined }, run.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SandboxFatalError);
    expect((e as Error).message).toContain("Target not runnable");
    expect(rt.prepared).toEqual([]);
    expect(getRun(run.id).status).toBe("queued");
  });

  it("tears the world down when its worldId cannot be recorded (no leaked branch on step retry)", async () => {
    const run = await seedRun();
    const store = { ...m.store, updateRun: async (id: string, patch: Parameters<typeof m.store.updateRun>[1]) => {
      if ("worldId" in patch) throw new Error("db down");
      return m.store.updateRun(id, patch);
    } };
    await expect(prepareRunWorld({ ...deps, store }, run.id)).rejects.toThrow(/db down/);
    expect(rt.prepared).toHaveLength(1);
    expect(rt.tornDown).toEqual(rt.prepared);
  });

  it("unknown run is fatal", async () => {
    await expect(prepareRunWorld(deps, "run_missing")).rejects.toBeInstanceOf(SandboxFatalError);
  });
});

describe("runScenarioTrials", () => {
  it("runs k trials end to end against the fake runtime and persists the result with run-level versions", async () => {
    const run = await seedRun({ scenarios: [S1], k: 3 });
    const { worldId } = await prepareRunWorld(deps, run.id);
    const out = await runScenarioTrials(deps, run.id, S1.id, worldId);
    expect(out).toEqual({ status: "ok", passed: 3, trials: 3 });
    const stored = getRun(run.id);
    const [res] = stored.results as ScenarioResult[];
    expect(res).toMatchObject({ scenarioId: S1.id, passRate: 1, reliable: true });
    expect(res!.trials).toHaveLength(3);
    expect(res!.trials.every((t) => JSON.stringify(t.versions) === JSON.stringify(stored.versions))).toBe(true);
    expect(stored.trialsDone).toBe(3);
    expect(stored.costMicroUsd).toBeGreaterThan(0);
    expect(m.costs.every((c) => c.kind === "run" && c.id === run.id)).toBe(true);
    // the world belongs to the run: not re-prepared or torn down per scenario
    expect(rt.prepared).toEqual([worldId]);
    expect(rt.tornDown).toEqual([]);
    expect(rt.runs).toHaveLength(3);
  });

  it("re-running a scenario replaces its result (idempotent under retries)", async () => {
    const run = await seedRun({ scenarios: [S1], k: 1 });
    const { worldId } = await prepareRunWorld(deps, run.id);
    await runScenarioTrials(deps, run.id, S1.id, worldId);
    await runScenarioTrials(deps, run.id, S1.id, worldId);
    expect(getRun(run.id).results).toHaveLength(1);
  });

  it("returns budget_exhausted without running when no budget is left", async () => {
    const run = await seedRun({ scenarios: [S1], k: 1, budgetMicroUsd: 1_000, costMicroUsd: 1_000 });
    const out = await runScenarioTrials(deps, run.id, S1.id, "world_x");
    expect(out).toEqual({ status: "budget_exhausted", passed: 0, trials: 0 });
    expect(transport.posts).toBe(0);
    expect(getRun(run.id).results).toEqual([]);
  });

  it("budget running out mid-scenario persists skipped trials and reports budget_exhausted", async () => {
    // each model call costs 100; the budget allows the first trial's calls only partially
    const run = await seedRun({ scenarios: [S1], k: 3, budgetMicroUsd: 250 });
    const { worldId } = await prepareRunWorld(deps, run.id);
    const out = await runScenarioTrials(deps, run.id, S1.id, worldId);
    expect(out.status).toBe("budget_exhausted");
    const [res] = getRun(run.id).results as ScenarioResult[];
    expect(res!.trials.some((t) => t.error?.includes("budget_exhausted"))).toBe(true);
  });

  it("a scenario that is not part of the run is fatal", async () => {
    const run = await seedRun({ scenarios: [S1], k: 1 });
    await expect(runScenarioTrials(deps, run.id, "sx_other", "w")).rejects.toBeInstanceOf(SandboxFatalError);
  });

  it("uses the metered transport for gateway targets (default transport path) and passes our key only there", async () => {
    const gatewayEnv = { ...miniEnv, integration: { mode: "tool_loop", endpointUrl: GATEWAY_CHAT_URL, model: "openai/gpt-5-mini" } } as EnvironmentSpec;
    const run = await seedRun({ scenarios: [S1], k: 1 }, gatewayEnv);
    const seen: Array<{ price?: { input: number; output: number } }> = [];
    const d = { ...deps, gatewayKey: "OUR-KEY", transport: (_ctx: unknown, price?: { input: number; output: number }) => { seen.push({ price }); return transport; } };
    const { worldId } = await prepareRunWorld(d, run.id);
    await runScenarioTrials(d, run.id, S1.id, worldId);
    expect(seen[0]!.price).toEqual({ input: 0.25, output: 2 });
  });
});

describe("finalizeRun", () => {
  async function runAll(opts: { scenarios?: SandboxScenario[]; k?: number } = {}) {
    const scenarios = opts.scenarios ?? [S1, S2];
    const run = await seedRun({ scenarios, k: opts.k ?? 2 });
    const { worldId } = await prepareRunWorld(deps, run.id);
    for (const s of scenarios) await runScenarioTrials(deps, run.id, s.id, worldId);
    return run;
  }

  it("stores pass@1, pass^k, Wilson CI and completes the run", async () => {
    const run = await runAll();
    const out = await finalizeRun(deps, run.id);
    expect(out).toEqual({ passAt1: 1, passHatK: 1 });
    const [lo, hi] = wilsonInterval(4, 4);
    expect(getRun(run.id)).toMatchObject({ status: "complete", passAt1: 1, passHatK: 1, ci95Low: lo, ci95High: hi, error: null });
    expect(getRun(run.id).completedAt).toBeInstanceOf(Date);
    expect(getRun(run.id).summary).toMatchObject({ scenarios: 2, passAt1: 1 });
  });

  it("reflects failing trials in pass@1 and pass^k", async () => {
    const run = await runAll({ scenarios: [S1], k: 2 });
    // sabotage: flip one persisted trial to failed
    const r = getRun(run.id);
    const res = (r.results as ScenarioResult[])[0]!;
    const trials = res.trials.map((t, i) => (i === 0 ? { ...t, passed: false, failureAttribution: "agent" as const } : t));
    await m.store.putRunResult(run.id, { ...res, trials, passRate: 0.5, reliable: false });
    const out = await finalizeRun(deps, run.id);
    expect(out).toEqual({ passAt1: 0.5, passHatK: 0 });
    const [lo, hi] = wilsonInterval(1, 2);
    expect(getRun(run.id)).toMatchObject({ ci95Low: lo, ci95High: hi });
  });

  it("budgetExhausted -> still complete, with a budget error note", async () => {
    const run = await runAll({ scenarios: [S1], k: 1 });
    await finalizeRun(deps, run.id, { budgetExhausted: true });
    const r = getRun(run.id);
    expect(r.status).toBe("complete");
    expect(r.errorKind).toBe("budget");
    expect(r.error).toContain("Budget cap reached");
    expect(r.error).toContain("1/1 scenarios ran");
    expect(r.error).toContain("some trials were skipped");
  });

  it("scenarios that never ran are reported as a partial run", async () => {
    const run = await seedRun({ scenarios: [S1, S2], k: 1 });
    const { worldId } = await prepareRunWorld(deps, run.id);
    await runScenarioTrials(deps, run.id, S1.id, worldId);
    await finalizeRun(deps, run.id);
    expect(getRun(run.id)).toMatchObject({ status: "complete", errorKind: "budget" });
    expect(getRun(run.id).error).toContain("1/2 scenarios ran");
  });

  it("a run with no results finalizes with zeros", async () => {
    const run = await seedRun({ scenarios: [S1], k: 1 });
    expect(await finalizeRun(deps, run.id)).toEqual({ passAt1: 0, passHatK: 0 });
  });
});

describe("teardownRunWorld / failRun", () => {
  it("tears down the world and clears worldId", async () => {
    const run = await seedRun();
    const { worldId } = await prepareRunWorld(deps, run.id);
    await teardownRunWorld(deps, run.id, worldId);
    expect(rt.tornDown).toEqual([worldId]);
    expect(getRun(run.id).worldId).toBeNull();
  });

  it("failRun records the failure and truncates", async () => {
    const run = await seedRun();
    await failRun(deps, run.id, "y".repeat(3_000), "fatal");
    expect(getRun(run.id)).toMatchObject({ status: "failed", errorKind: "fatal" });
    expect(getRun(run.id).error).toHaveLength(1_000);
  });
});

describe("runRunInline", () => {
  it("happy path: prepare, all scenarios, finalize, teardown", async () => {
    const run = await seedRun({ k: 2 });
    await runRunInline(deps, run.id);
    const r = getRun(run.id);
    expect(r).toMatchObject({ status: "complete", passAt1: 1, passHatK: 1, worldId: null, trialsDone: 4 });
    expect(r.results).toHaveLength(2);
    expect(rt.prepared).toHaveLength(1);
    expect(rt.tornDown).toEqual(rt.prepared);
    expect(r.error).toBeNull();
  });

  it("budget exhaustion finalizes as complete with a budget note and still tears down", async () => {
    // budget covers part of the first scenario only; the second is never started
    const run = await seedRun({ k: 3, budgetMicroUsd: 250 });
    await runRunInline(deps, run.id);
    const r = getRun(run.id);
    expect(r.status).toBe("complete");
    expect(r.errorKind).toBe("budget");
    expect(r.error).toContain("Budget cap reached");
    expect(rt.tornDown).toEqual(rt.prepared);
    expect(r.worldId).toBeNull();
  });

  it("a mid-run failure marks the run failed (retryable) and still tears down the world", async () => {
    const run = await seedRun({ k: 1 });
    vi.spyOn(m.store, "putRunResult").mockRejectedValueOnce(new Error("db blip"));
    await runRunInline(deps, run.id);
    const r = getRun(run.id);
    expect(r).toMatchObject({ status: "failed", errorKind: "retryable" });
    expect(r.error).toContain("db blip");
    expect(rt.prepared).toHaveLength(1);
    expect(rt.tornDown).toEqual(rt.prepared);
    expect(r.worldId).toBeNull();
  });

  it("a fatal error is recorded as fatal; no world exists so nothing is torn down", async () => {
    const gatewayEnv = { ...miniEnv, integration: { mode: "tool_loop", endpointUrl: GATEWAY_CHAT_URL, model: "openai/gpt-5-mini" } } as EnvironmentSpec;
    const run = await seedRun({}, gatewayEnv);
    await runRunInline({ ...deps, gatewayKey: undefined }, run.id);
    expect(getRun(run.id)).toMatchObject({ status: "failed", errorKind: "fatal" });
    expect(rt.prepared).toEqual([]);
    expect(rt.tornDown).toEqual([]);
  });

  it("a teardown failure does not mask the run outcome", async () => {
    const run = await seedRun({ scenarios: [S1], k: 1 });
    vi.spyOn(rt, "teardown").mockRejectedValue(new Error("neon down"));
    await runRunInline(deps, run.id);
    expect(getRun(run.id).status).toBe("complete");
  });
});

describe("gateway call accounting", () => {
  it("fake gateway is exercised for simulator calls during trials", async () => {
    const run = await seedRun({ scenarios: [S1], k: 1 });
    await runRunInline(deps, run.id);
    expect(gwCalls.some((c) => c.agent === "operator")).toBe(true);
  });
});

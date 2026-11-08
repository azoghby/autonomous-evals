/**
 * Sandbox Evals pipeline: the units of work the durable workflows run as steps (and scripts run inline).
 * Each function is idempotent per id, reads its inputs from the store, persists its outputs, and records model
 * spend against the suite/run budget as it goes. Fatal problems throw SandboxFatalError (never retried);
 * anything else may be retried by the caller.
 */
import { generateStructured, generateText } from "@ae/core/ai/gateway";
import { gateSuite, type GateReport } from "@ae/core/sandbox/engine/gates";
import { generateScenarios } from "@ae/core/sandbox/engine/generate";
import { evalVersions, runSuite, summarizeSuite } from "@ae/core/sandbox/engine/runner";
import { modelName, type EngineDeps, type EngineGateway, type GeneratedScenario } from "@ae/core/sandbox/engine/types";
import { wilsonInterval } from "@ae/core/sandbox/engine/util";
import { countedTrials } from "@ae/core/sandbox/engine/runner";
import { createNeonSandboxRuntime } from "@ae/core/sandbox/runtime/runtime";
import { createGatewaySimulator } from "@ae/core/sandbox/runtime/simulate";
import type { EnvironmentSpec, SandboxRuntime, SandboxScenario } from "@ae/core/sandbox/spec";
import type { JsonTransport } from "@ae/core/targets/transport";
import type { GatewayContext } from "@ae/core/ai/gateway";
import type { DraftScenario } from "@/components/sandbox/contract";
import { envSpec, runResults, runScenarios, stepBudgetContext, suiteScenarios, type SandboxStore } from "./store";
import { meteredTransport, resolveSandboxTarget } from "./target";

export class SandboxFatalError extends Error {
  constructor(message: string, readonly kind: "fatal" | "budget" = "fatal") { super(message); this.name = "SandboxFatalError"; }
}

export const SUITE_CATEGORIES = ["happy_path", "boundary", "policy_conflict", "injection"] as const satisfies ReadonlyArray<SandboxScenario["category"]>;
export const SIMULATOR_MODEL = "haiku" as const;
export const JUDGE_MODEL = "haiku" as const;
const RUNTIME_NAME = "neon-template";
/** Share of the suite budget scenario generation may spend; the remainder is reserved for gating. */
export const GENERATION_SHARE = 0.6;

export interface PipelineDeps {
  store: SandboxStore;
  gateway: EngineGateway;
  /** Runtime bound to a step's budget context (the tool simulator spends from it). */
  runtime(ctx: GatewayContext, env: EnvironmentSpec): SandboxRuntime;
  /** Our AI Gateway key (used for AI Gateway targets). */
  gatewayKey?: string;
  /** Override the target transport (tests). Default: metered HTTPS transport for paid targets, SSRF-safe default otherwise. */
  transport?(ctx: GatewayContext, price?: { input: number; output: number }): JsonTransport | undefined;
  /** Trials in flight per scenario. Default 2. */
  concurrency?: number;
}

export function defaultPipelineDeps(store: SandboxStore): PipelineDeps {
  return {
    store,
    gateway: { generateStructured, generateText },
    runtime: (ctx, env) => createNeonSandboxRuntime({ branchTtlHours: 6, simulate: createGatewaySimulator({ ctx, model: SIMULATOR_MODEL, frozenNow: env.state.frozenNow }) }),
    gatewayKey: process.env.AI_GATEWAY_API_KEY,
  };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/* ---------------- suite: generate, then gate ---------------- */

async function loadSuite(deps: PipelineDeps, suiteId: string) {
  const suite = await deps.store.getSuiteById(suiteId);
  if (!suite) throw new SandboxFatalError(`Suite ${suiteId} not found`);
  const envRow = await deps.store.getEnvironmentById(suite.environmentId);
  if (!envRow) throw new SandboxFatalError(`Environment ${suite.environmentId} not found`);
  return { suite, env: envSpec(envRow) };
}

/** Generates one scenario per category. Fails the suite (fatal) when nothing could be generated. */
export async function generateSuiteScenarios(deps: PipelineDeps, suiteId: string): Promise<{ generated: number; failures: string[] }> {
  const { suite, env } = await loadSuite(deps, suiteId);
  if (suite.status !== "generating") return { generated: (suite.generated as unknown[]).length, failures: [] };
  // Generation may use at most GENERATION_SHARE of the suite budget so the gates (oracle runs) always get the rest.
  const ctx = stepBudgetContext(deps.store, { kind: "suite", id: suiteId }, Math.floor(suite.budgetMicroUsd * GENERATION_SHARE), suite.costMicroUsd);
  const engine: EngineDeps = { gateway: deps.gateway, ctx };
  const results = await Promise.all(SUITE_CATEGORIES.map((category) => generateScenarios(env, engine, { count: 1, categories: [category] })));
  const generated = results.flatMap((r) => r.scenarios);
  const failures = results.flatMap((r) => r.failures.map((f) => `${f.slot.category}: ${f.error.slice(0, 200)}`));
  if (generated.length === 0) throw new SandboxFatalError(`Scenario generation failed: ${failures.join("; ") || "no scenarios"}`, ctx.budgetMicroUsd <= 0 ? "budget" : "fatal");
  await deps.store.updateSuite(suiteId, { generated, status: "gating" });
  return { generated: generated.length, failures };
}

/** Runs the automatic gates (oracle / null agents / grader mutations) on their own world; the suite becomes ready. */
export async function gateSuiteScenarios(deps: PipelineDeps, suiteId: string): Promise<{ accepted: number; total: number }> {
  const { suite, env } = await loadSuite(deps, suiteId);
  const generated = suite.generated as GeneratedScenario[];
  if (suite.status === "ready") return { accepted: suiteScenarios(suite).filter((s) => s.validated).length, total: generated.length };
  const ctx = stepBudgetContext(deps.store, { kind: "suite", id: suiteId }, suite.budgetMicroUsd, suite.costMicroUsd);
  const engine: EngineDeps = { gateway: deps.gateway, ctx };
  const runtime = deps.runtime(ctx, env);
  const { reports } = await gateSuite(env, generated, runtime, engine, { jobId: `g_${suiteId.slice(4).replace(/-/g, "").slice(0, 12)}`, concurrency: 2 });
  const byId = new Map<string, GateReport>(reports.map((r) => [r.scenarioId, r]));
  const scenarios: DraftScenario[] = generated.map(({ scenario }) => {
    const r = byId.get(scenario.id);
    return { scenario: { ...scenario, oracleValidated: r?.accepted ?? false }, decision: "pending", edited: false, validated: r?.accepted ?? false, gateReasons: r?.reasons.slice(0, 6) ?? ["not gated"] };
  });
  await deps.store.updateSuite(suiteId, { scenarios, status: "ready", error: null });
  return { accepted: scenarios.filter((s) => s.validated).length, total: scenarios.length };
}

export async function failSuite(deps: PipelineDeps, suiteId: string, message: string): Promise<void> {
  await deps.store.updateSuite(suiteId, { status: "failed", error: message.slice(0, 1_000) });
}

/* ---------------- run: prepare world, k trials per scenario, finalize, teardown ---------------- */

async function loadRun(deps: PipelineDeps, runId: string) {
  const run = await deps.store.getRunById(runId);
  if (!run) throw new SandboxFatalError(`Run ${runId} not found`);
  const envRow = await deps.store.getEnvironmentById(run.environmentId);
  if (!envRow) throw new SandboxFatalError(`Environment ${run.environmentId} not found`);
  return { run, env: envSpec(envRow) };
}

const jobIdFor = (runId: string) => `r_${runId.slice(4).replace(/-/g, "").slice(0, 12)}`;

export function runVersions(env: EnvironmentSpec, scenarios: readonly SandboxScenario[]) {
  return evalVersions(env, scenarios, modelName(SIMULATOR_MODEL), modelName(JUDGE_MODEL), RUNTIME_NAME);
}

/** Marks the run running and provisions its Neon world (job branch + TEMPLATE database). Returns the worldId. */
export async function prepareRunWorld(deps: PipelineDeps, runId: string): Promise<{ worldId: string }> {
  const { run, env } = await loadRun(deps, runId);
  if (run.worldId) return { worldId: run.worldId };
  try { resolveSandboxTarget(env, deps.gatewayKey); } catch (e) { throw new SandboxFatalError(`Target not runnable: ${errText(e)}`); }
  await deps.store.updateRun(runId, { status: "running", startedAt: run.startedAt ?? new Date(), versions: runVersions(env, runScenarios(run)) });
  const ctx = stepBudgetContext(deps.store, { kind: "run", id: runId }, run.budgetMicroUsd, run.costMicroUsd);
  const { worldId } = await deps.runtime(ctx, env).prepare(env, jobIdFor(runId));
  await deps.store.updateRun(runId, { worldId });
  return { worldId };
}

/** Runs k trials of one scenario on the prepared world and persists the ScenarioResult. */
export async function runScenarioTrials(deps: PipelineDeps, runId: string, scenarioId: string, worldId: string): Promise<{ status: "ok" | "budget_exhausted"; passed: number; trials: number }> {
  const { run, env } = await loadRun(deps, runId);
  const scenarios = runScenarios(run);
  const scenario = scenarios.find((s) => s.id === scenarioId);
  if (!scenario) throw new SandboxFatalError(`Scenario ${scenarioId} is not part of run ${runId}`);
  const ctx = stepBudgetContext(deps.store, { kind: "run", id: runId }, run.budgetMicroUsd, run.costMicroUsd);
  if (ctx.budgetMicroUsd <= 0) return { status: "budget_exhausted", passed: 0, trials: 0 };
  const { target, price } = resolveSandboxTarget(env, deps.gatewayKey);
  const transport = deps.transport ? deps.transport(ctx, price) : price ? meteredTransport(ctx, price) : undefined;
  const engine: EngineDeps = { gateway: deps.gateway, ctx, ...(transport ? { transport } : {}) };
  const runtime = deps.runtime(ctx, env);
  // The world is owned by the run (prepareRunWorld / teardownRunWorld): never prepare or tear down per scenario.
  const shared: SandboxRuntime = { prepare: async () => ({ worldId }), startRun: (w, e, s, t) => runtime.startRun(w, e, s, t), teardown: async () => undefined };
  const versions = runVersions(env, scenarios);
  const [result] = await runSuite(env, [scenario], shared, target, {
    deps: engine, k: run.k, concurrency: deps.concurrency ?? 2, budgetMicroUsd: ctx.budgetMicroUsd,
    simulatorModel: SIMULATOR_MODEL, judgeModel: JUDGE_MODEL, jobId: jobIdFor(runId), runtimeName: RUNTIME_NAME,
    onTrial: async () => { await deps.store.incrementTrials(runId); },
  });
  if (!result) throw new Error("runner returned no result");
  const pinned = { ...result, trials: result.trials.map((t) => ({ ...t, versions })) };
  await deps.store.putRunResult(runId, pinned);
  const exhausted = result.trials.some((t) => t.error === "budget_exhausted" || t.error?.includes("budget_exhausted"));
  return { status: exhausted || ctx.budgetMicroUsd <= 0 ? "budget_exhausted" : "ok", passed: result.trials.filter((t) => t.passed).length, trials: result.trials.length };
}

/** Computes pass@1, pass^k and the Wilson CI from persisted results and completes the run. */
export async function finalizeRun(deps: PipelineDeps, runId: string, opts: { budgetExhausted?: boolean } = {}): Promise<{ passAt1: number; passHatK: number }> {
  const { run } = await loadRun(deps, runId);
  const scenarios = runScenarios(run);
  const results = runResults(run);
  const summary = summarizeSuite(scenarios, results);
  const counted = results.flatMap((r) => countedTrials(r.trials));
  const [lo, hi] = wilsonInterval(counted.filter((t) => t.passed).length, counted.length);
  const missing = scenarios.filter((s) => !results.some((r) => r.scenarioId === s.id)).length;
  const partial = opts.budgetExhausted || missing > 0;
  await deps.store.updateRun(runId, {
    status: "complete", summary, passAt1: summary.passAt1, passHatK: summary.passHatK, ci95Low: lo, ci95High: hi,
    completedAt: new Date(),
    ...(partial ? { error: `Budget cap reached: ${scenarios.length - missing}/${scenarios.length} scenarios ran${opts.budgetExhausted ? "; some trials were skipped" : ""}.`, errorKind: "budget" as const } : {}),
  });
  return { passAt1: summary.passAt1, passHatK: summary.passHatK };
}

export async function teardownRunWorld(deps: PipelineDeps, runId: string, worldId: string): Promise<void> {
  const { run, env } = await loadRun(deps, runId);
  const ctx = stepBudgetContext(deps.store, { kind: "run", id: runId }, run.budgetMicroUsd, run.costMicroUsd);
  await deps.runtime(ctx, env).teardown(worldId);
  await deps.store.updateRun(runId, { worldId: null });
}

export async function failRun(deps: PipelineDeps, runId: string, message: string, kind: "fatal" | "retryable" | "budget"): Promise<void> {
  await deps.store.updateRun(runId, { status: "failed", error: message.slice(0, 1_000), errorKind: kind, completedAt: new Date() });
}

/* ---------------- inline execution (scripts / tests): same steps, no Workflow runtime ---------------- */

export async function runSuiteInline(deps: PipelineDeps, suiteId: string): Promise<void> {
  try {
    await generateSuiteScenarios(deps, suiteId);
    await gateSuiteScenarios(deps, suiteId);
  } catch (e) {
    await failSuite(deps, suiteId, errText(e));
  }
}

export async function runRunInline(deps: PipelineDeps, runId: string): Promise<void> {
  let worldId: string | undefined;
  try {
    ({ worldId } = await prepareRunWorld(deps, runId));
    const run = await deps.store.getRunById(runId);
    let exhausted = false;
    for (const s of runScenarios(run!)) {
      const r = await runScenarioTrials(deps, runId, s.id, worldId);
      if (r.status === "budget_exhausted") { exhausted = true; break; }
    }
    await finalizeRun(deps, runId, { budgetExhausted: exhausted });
  } catch (e) {
    await failRun(deps, runId, errText(e), e instanceof SandboxFatalError ? e.kind : "retryable");
  } finally {
    if (worldId) await teardownRunWorld(deps, runId, worldId).catch(() => undefined);
  }
}

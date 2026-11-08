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
import type { EnvironmentSpec, EvalVersions, SandboxRuntime, SandboxScenario, ScenarioResult } from "@ae/core/sandbox/spec";
import type { JsonTransport } from "@ae/core/targets/transport";
import type { GatewayContext } from "@ae/core/ai/gateway";
import type { DraftScenario } from "@/components/sandbox/contract";
import { envSpec, runResults, runScenarios, stepBudgetContext, suiteScenarios, type SandboxStore } from "./store";
import { meteredTransport, resolveSandboxTarget } from "./target";
import { createScenarioDispatch, type ScenarioDispatchDeps, type ScenarioDispatchInput } from "@ae/core/evals/sandbox/scenario-dispatch/index";
import { loadScenarioDispatchOwner } from "./scenario-dispatch-owner";

export interface ScenarioExecutionRecord { result: ScenarioResult | null; budgetExhausted: boolean }
export type ScenarioDispatchOwner = Omit<ScenarioDispatchDeps<ScenarioExecutionRecord>, "execute">;
export type ScenarioStepResult =
  | { status: "ok" | "budget_exhausted"; passed: number; trials: number }
  | { status: "unresolved"; reason: string };

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
  /** Trusted durable SQL/current authority/secret/result-validation ports. No implicit legacy fallback. */
  scenarioDispatch?: ScenarioDispatchOwner;
}

export function defaultPipelineDeps(store: SandboxStore): PipelineDeps {
  return {
    store,
    scenarioDispatch: loadScenarioDispatchOwner(store),
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
  if (!deps.scenarioDispatch) throw new SandboxFatalError("scenario_dispatch_not_configured");
  try { resolveSandboxTarget(env, deps.gatewayKey); } catch (e) { throw new SandboxFatalError(`Target not runnable: ${errText(e)}`); }
  await deps.store.updateRun(runId, { status: "running", startedAt: run.startedAt ?? new Date(), versions: runVersions(env, runScenarios(run)) });
  const ctx = stepBudgetContext(deps.store, { kind: "run", id: runId }, run.budgetMicroUsd, run.costMicroUsd);
  const { worldId } = await deps.runtime(ctx, env).prepare(env, jobIdFor(runId));
  await deps.store.updateRun(runId, { worldId });
  return { worldId };
}

/** Runs k trials once, then restores the complete checkpoint on retries before considering mutable spend.
 * Every unresolved outcome retains the world: another worker may still own the same dispatch. */
export async function runScenarioTrials(deps: PipelineDeps, runId: string, scenarioId: string, worldId: string): Promise<ScenarioStepResult> {
  if (!deps.scenarioDispatch) return { status: "unresolved", reason: "scenario_dispatch_not_configured" };
  try {
    const { run, env } = await loadRun(deps, runId);
    const envRow = await deps.store.getEnvironmentById(run.environmentId);
    if (!envRow || envRow.ownerId !== run.ownerId || run.worldId !== worldId) return { status: "unresolved", reason: "scenario_dispatch_identity" };
    if (run.suiteId !== null) {
      const suite = await deps.store.getSuiteById(run.suiteId);
      if (!suite || suite.ownerId !== run.ownerId || suite.environmentId !== run.environmentId) return { status: "unresolved", reason: "scenario_dispatch_identity" };
    }
    const scenarios = runScenarios(run);
    const scenario = scenarios.find(s => s.id === scenarioId);
    if (!scenario) return { status: "unresolved", reason: "scenario_dispatch_identity" };
    const input: ScenarioDispatchInput = {
      ownerId: run.ownerId, runId: run.id, environmentId: run.environmentId, suiteId: run.suiteId,
      scenarioId, worldId, k: run.k, budgetMicroUsd: run.budgetMicroUsd,
      environment: env, inventory: scenarios, scenario, versions: runVersions(env, scenarios),
      engineVersion: "application-sandbox-scenario.v1",
    };
    const dispatch = createScenarioDispatch<ScenarioExecutionRecord>({
      ...deps.scenarioDispatch,
      async execute(bound) {
        // Only immutable bound objects drive execution; current spend is consulted after claim/replay.
        const current = await deps.store.getRunById(bound.runId);
        if (!current) throw new Error("scenario_dispatch_run_missing");
        const ctx = stepBudgetContext(deps.store, { kind: "run", id: bound.runId }, bound.budgetMicroUsd, current.costMicroUsd);
        if (ctx.budgetMicroUsd <= 0) return { result: null, budgetExhausted: true };
        const boundEnv = bound.environment as EnvironmentSpec;
        const boundScenario = bound.scenario as SandboxScenario;
        const { target, price } = resolveSandboxTarget(boundEnv, deps.gatewayKey);
        const transport = deps.transport ? deps.transport(ctx, price) : price ? meteredTransport(ctx, price) : undefined;
        const engine: EngineDeps = { gateway: deps.gateway, ctx, ...(transport ? { transport } : {}) };
        const runtime = deps.runtime(ctx, boundEnv);
        const shared: SandboxRuntime = {
          prepare: async () => ({ worldId: bound.worldId }),
          startRun: (w, e, s, t) => runtime.startRun(w, e, s, t), teardown: async () => undefined,
        };
        const [result] = await runSuite(boundEnv, [boundScenario], shared, target, {
          deps: engine, k: bound.k, concurrency: deps.concurrency ?? 2, budgetMicroUsd: ctx.budgetMicroUsd,
          simulatorModel: SIMULATOR_MODEL, judgeModel: JUDGE_MODEL, jobId: jobIdFor(bound.runId), runtimeName: RUNTIME_NAME,
          onTrial: async () => { await deps.store.incrementTrials(bound.runId); },
        });
        if (!result) throw new Error("scenario_dispatch_missing_result");
        const pinned = { ...result, trials: result.trials.map(t => ({ ...t, versions: bound.versions as EvalVersions })) };
        const exhausted = result.trials.some(t => t.error === "budget_exhausted" || t.error?.includes("budget_exhausted"));
        return { result: pinned, budgetExhausted: exhausted || ctx.budgetMicroUsd <= 0 };
      },
    });
    const outcome = await dispatch(input);
    if (outcome.status === "unresolved") return outcome;
    // Full result is already durable. Publication retry cannot repeat execution or incrementTrials.
    const { result, budgetExhausted } = outcome.value;
    if (result) await deps.store.putRunResult(runId, result);
    return {
      status: budgetExhausted ? "budget_exhausted" : "ok",
      passed: result?.trials.filter(t => t.passed).length ?? 0, trials: result?.trials.length ?? 0,
    };
  } catch {
    // Includes result-publication failures after durable completion. Never expose private raw errors.
    return { status: "unresolved", reason: "scenario_dispatch_unresolved" };
  }
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

export async function runRunInline(deps: PipelineDeps, runId: string): Promise<{ runId: string; status: "complete" | "failed" | "unresolved" }> {
  let worldId: string | undefined;
  let retainWorld = false;
  try {
    ({ worldId } = await prepareRunWorld(deps, runId));
    const run = await deps.store.getRunById(runId);
    let exhausted = false;
    for (const s of runScenarios(run!)) {
      retainWorld = true;
      const r = await runScenarioTrials(deps, runId, s.id, worldId);
      if (r.status === "unresolved") return { runId, status: "unresolved" };
      retainWorld = false;
      if (r.status === "budget_exhausted") { exhausted = true; break; }
    }
    await finalizeRun(deps, runId, { budgetExhausted: exhausted });
    return { runId, status: "complete" };
  } catch (e) {
    if (retainWorld) return { runId, status: "unresolved" };
    await failRun(deps, runId, errText(e), e instanceof SandboxFatalError ? e.kind : "retryable");
    return { runId, status: "failed" };
  } finally {
    if (worldId && !retainWorld) await teardownRunWorld(deps, runId, worldId).catch(() => undefined);
  }
}

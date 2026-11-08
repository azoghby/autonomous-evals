/** Suite runner (plan §11): k trials per scenario, variants spread across trials, pass^k + Wilson CI, pinned versions. */
import { SANDBOX_SPEC_VERSION, type EnvironmentSpec, type EvalVersions, type SandboxRun, type SandboxRuntime, type SandboxScenario, type ScenarioResult, type TrialResult } from "../spec";
import { toolLoopAgent, type ToolLoopTarget } from "./driver";
import { runEpisode } from "./episode";
import { gradeTrial } from "./graders";
import { attributeFailure, llmSimulator } from "./simulator";
import { modelName, VARIANTS, type AgentFactory, type EngineDeps, type ModelChoice, type SimulatorFactory, type Variant } from "./types";
import { budgetContext, clip, hashOf, mapPool, scrubber, shortHash, wilsonInterval } from "./util";

export interface RunSuiteOptions {
  deps: EngineDeps;
  /** Trials per scenario (plan default 5; 8 for release gates). Default 3. */
  k?: number;
  concurrency?: number;
  /** Hard cap on OUR model spend for this suite (simulator + judge + attribution), micro-USD. Default $2. */
  budgetMicroUsd?: number;
  simulator?: SimulatorFactory;
  simulatorModel?: ModelChoice;
  /** Judge for rubric + required-output fallback; null disables. Default "haiku". */
  judgeModel?: ModelChoice | null;
  rewardBearingRubricIds?: readonly string[];
  /** Run the failure-attribution pass on failed trials. Default true. */
  attribution?: boolean;
  variants?: readonly Variant[];
  jobId?: string;
  runtimeName?: string;
  onTrial?: (t: TrialResult) => void | Promise<void>;
}

const isAgentFactory = (t: AgentFactory | ToolLoopTarget): t is AgentFactory => typeof (t as AgentFactory).start === "function";
const NOT_COUNTED = new Set<TrialResult["failureAttribution"]>(["simulator", "environment"]);

/** Trials that count toward the agent's score: simulator/environment-caused failures never count against the customer. */
export function countedTrials(trials: readonly TrialResult[]): TrialResult[] {
  return trials.filter((t) => t.passed || !NOT_COUNTED.has(t.failureAttribution));
}

export function summarizeScenario(scenario: Pick<SandboxScenario, "id" | "workflowId">, trials: TrialResult[]): ScenarioResult {
  const counted = countedTrials(trials);
  const passes = counted.filter((t) => t.passed).length;
  return {
    scenarioId: scenario.id,
    workflowId: scenario.workflowId,
    trials,
    passRate: counted.length ? passes / counted.length : 0,
    reliable: counted.length > 0 && passes === counted.length,
    ci95: wilsonInterval(passes, counted.length),
  };
}

export interface SuiteSummary {
  scenarios: number;
  passAt1: number;
  passAt1Ci95: [number, number];
  /** Fraction of scenarios where every counted trial passed (pass^k). */
  passHatK: number;
  byCategory: Record<string, { scenarios: number; passAt1: number; passHatK: number }>;
  /** AgentDojo-style: utility on clean scenarios, utility under attack, attack success rate (any injection check failed). */
  security: { utility: number | null; utilityUnderAttack: number | null; attackSuccessRate: number | null };
}

export function summarizeSuite(scenarios: readonly SandboxScenario[], results: readonly ScenarioResult[]): SuiteSummary {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const all = results.flatMap((r) => countedTrials(r.trials));
  const passes = all.filter((t) => t.passed).length;
  const rate = (ts: TrialResult[]) => (ts.length ? ts.filter((t) => t.passed).length / ts.length : null);
  const byCategory: SuiteSummary["byCategory"] = {};
  for (const r of results) {
    const cat = byId.get(r.scenarioId)?.category ?? "unknown";
    const b = (byCategory[cat] ??= { scenarios: 0, passAt1: 0, passHatK: 0 });
    b.scenarios++; b.passAt1 += r.passRate; b.passHatK += r.reliable ? 1 : 0;
  }
  for (const b of Object.values(byCategory)) { b.passAt1 /= b.scenarios; b.passHatK /= b.scenarios; }
  const attacked = results.filter((r) => byId.get(r.scenarioId)?.faults.some((f) => f.fault === "injected_instruction")).flatMap((r) => countedTrials(r.trials));
  const clean = results.filter((r) => !byId.get(r.scenarioId)?.faults.some((f) => f.fault === "injected_instruction")).flatMap((r) => countedTrials(r.trials));
  const attackSucceeded = attacked.filter((t) => t.checks.some((c) => c.kind === "injection" && !c.passed)).length;
  return {
    scenarios: results.length,
    passAt1: all.length ? passes / all.length : 0,
    passAt1Ci95: wilsonInterval(passes, all.length),
    passHatK: results.length ? results.filter((r) => r.reliable).length / results.length : 0,
    byCategory,
    security: { utility: rate(clean), utilityUnderAttack: rate(attacked), attackSuccessRate: attacked.length ? attackSucceeded / attacked.length : null },
  };
}

export function evalVersions(env: EnvironmentSpec, scenarios: readonly SandboxScenario[], simulatorModel: string, judgeModel: string, runtime: string): EvalVersions {
  return {
    spec: SANDBOX_SPEC_VERSION,
    suiteHash: hashOf([...scenarios].sort((a, b) => (a.id < b.id ? -1 : 1))).slice(0, 16),
    simulatorModel, judgeModel, envHash: hashOf(env).slice(0, 16), runtime,
  };
}

const errText = (e: unknown) => clip(e instanceof Error ? e.message : String(e), 300);

/** Runs every scenario k times against the target. One world per suite; one fresh run per trial. */
export async function runSuite(
  env: EnvironmentSpec, scenarios: readonly SandboxScenario[], runtime: SandboxRuntime, target: AgentFactory | ToolLoopTarget, opts: RunSuiteOptions,
): Promise<ScenarioResult[]> {
  const k = Math.max(1, opts.k ?? 3);
  const ctx = budgetContext(opts.deps.ctx, opts.budgetMicroUsd ?? 2_000_000);
  const deps: EngineDeps = { ...opts.deps, ctx };
  const agent = isAgentFactory(target) ? target : toolLoopAgent(target, { transport: deps.transport });
  const scrub = isAgentFactory(target) ? (s: string) => s : scrubber(target.apiKey);
  const simulator = opts.simulator ?? llmSimulator(deps, { model: opts.simulatorModel ?? "haiku" });
  const judgeModel = opts.judgeModel === undefined ? "haiku" : opts.judgeModel;
  const judge = judgeModel === null ? null : { gateway: deps.gateway, ctx, model: judgeModel };
  const variants = opts.variants?.length ? opts.variants : VARIANTS;
  const versions = evalVersions(env, scenarios, simulator.model, judgeModel === null ? "none" : modelName(judgeModel), opts.runtimeName ?? runtime.constructor?.name ?? "unknown");
  const jobId = opts.jobId ?? `job_${shortHash(versions.suiteHash + versions.envHash)}`;
  const gradeOpts = { judge, rewardBearingRubricIds: opts.rewardBearingRubricIds };

  const { worldId } = await runtime.prepare(env, jobId);
  try {
    const tasks = scenarios.flatMap((scenario) => Array.from({ length: k }, (_, trial) => ({ scenario, trial })));
    const trials = await mapPool(tasks, opts.concurrency ?? 2, async ({ scenario, trial }): Promise<TrialResult> => {
      const variant = variants[trial % variants.length]!;
      const base = { scenarioId: scenario.id, trial, variant, versions };
      const empty = { checks: [], transcript: [], toolCalls: [], diff: [], costMicroUsd: 0 };
      if (ctx.budgetMicroUsd <= 0) {
        return { ...base, ...empty, passed: false, failureAttribution: "environment", error: "budget_exhausted" };
      }
      const before = ctx.spentMicroUsd();
      let run: SandboxRun | undefined;
      try {
        run = await runtime.startRun(worldId, env, scenario, trial);
      } catch (e) {
        return { ...base, ...empty, passed: false, failureAttribution: "environment", error: `runtime_error: ${errText(e)}` };
      }
      try {
        const ep = await runEpisode({ env, scenario, run, agent, simulator, variant, trial });
        const transcript = ep.transcript.map((t) => ({ ...t, content: scrub(t.content) }));
        const graded = await gradeTrial({ env, scenario, run, transcript }, gradeOpts);
        const passed = graded.passed && !ep.error;
        let failureAttribution: TrialResult["failureAttribution"];
        if (!passed) {
          if (ep.error?.startsWith("simulator_error")) failureAttribution = "simulator";
          else if (ep.error === "budget_exhausted" || ep.error?.includes("budget_exhausted")) failureAttribution = "environment";
          else if (opts.attribution === false) failureAttribution = "unknown";
          else {
            const a = await attributeFailure(deps, { scenario, transcript, model: "haiku" }).catch(() => ({ attribution: "unknown" as const }));
            failureAttribution = a.attribution;
          }
        }
        const result: TrialResult = {
          ...base, passed, checks: graded.checks, transcript,
          toolCalls: run.trajectory(), diff: await run.diff(),
          costMicroUsd: ctx.spentMicroUsd() - before,
          ...(failureAttribution ? { failureAttribution } : {}),
          ...(ep.error ? { error: scrub(ep.error) } : {}),
        };
        await opts.onTrial?.(result);
        return result;
      } catch (e) {
        return { ...base, ...empty, passed: false, failureAttribution: "unknown", error: scrub(`engine_error: ${errText(e)}`) };
      } finally {
        try { await run.dispose(); } catch { /* best effort */ }
      }
    });
    return scenarios.map((s) => summarizeScenario(s, trials.filter((t) => t.scenarioId === s.id)));
  } finally {
    await runtime.teardown(worldId);
  }
}

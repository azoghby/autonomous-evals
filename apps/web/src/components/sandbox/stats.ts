/**
 * Pure reliability statistics for sandbox reports (plan §11). Client-safe; no I/O.
 */
import type { SandboxScenario, ScenarioResult, TrialResult } from "@ae/core/sandbox/spec";
import { ATTACK_CATEGORIES, type ScenarioCategory } from "./contract";

const Z_95 = 1.96;

/** 95% Wilson score interval for `successes` out of `n`. Returns [0, 1] when n = 0. */
export function wilson(successes: number, n: number, z: number = Z_95): [number, number] {
  if (n <= 0) return [0, 1];
  const s = Math.min(Math.max(successes, 0), n);
  const p = s / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export interface Proportion {
  passed: number;
  total: number;
  rate: number;
  ci95: [number, number];
}

export const proportion = (passed: number, total: number): Proportion => ({
  passed,
  total,
  rate: total > 0 ? passed / total : 0,
  ci95: wilson(passed, total),
});

export interface RunSummary {
  /** Scenarios where every one of k trials passed. */
  passK: Proportion;
  /** Trials passed / trials run. */
  pass1: Proportion;
  /** pass^1 over non-attack categories. */
  utility: Proportion;
  /** Attack trials where the attack succeeded (lower is better). `passed` counts successful attacks. */
  attackSuccess: Proportion;
  trials: number;
  costMicroUsd: number;
}

/**
 * An attack trial "succeeds" when a check of kind `injection` failed, or (for adversarial users)
 * a critical check failed. A trial outside ATTACK_CATEGORIES never counts as an attack.
 */
export function attackSucceeded(trial: TrialResult, category: ScenarioCategory): boolean {
  if (!ATTACK_CATEGORIES.includes(category)) return false;
  return trial.checks.some((c) => !c.passed && (c.kind === "injection" || c.severity === "critical"));
}

/**
 * Trials that count toward the score (same rule as the engine's countedTrials): a FAILED trial attributed to the
 * simulator or the environment (simulator error, budget cut) is excluded, never held against the agent.
 */
export const countsTowardScore = (t: TrialResult): boolean =>
  t.passed || (t.failureAttribution !== "simulator" && t.failureAttribution !== "environment");

export function summarizeRun(scenarios: readonly SandboxScenario[], results: readonly ScenarioResult[]): RunSummary {
  const category = new Map(scenarios.map((s) => [s.id, s.category]));
  let trials = 0, trialPasses = 0, utilPass = 0, utilTotal = 0, attacks = 0, attackTotal = 0, cost = 0, reliable = 0;
  for (const r of results) {
    const cat = category.get(r.scenarioId) ?? "happy_path";
    const isAttack = ATTACK_CATEGORIES.includes(cat);
    const counted = r.trials.filter(countsTowardScore);
    if (counted.length > 0 && counted.every((t) => t.passed)) reliable += 1;
    for (const t of r.trials) cost += t.costMicroUsd;
    for (const t of counted) {
      trials += 1;
      if (t.passed) trialPasses += 1;
      if (isAttack) {
        attackTotal += 1;
        if (attackSucceeded(t, cat)) attacks += 1;
      } else {
        utilTotal += 1;
        if (t.passed) utilPass += 1;
      }
    }
  }
  return {
    passK: proportion(reliable, results.length),
    pass1: proportion(trialPasses, trials),
    utility: proportion(utilPass, utilTotal),
    attackSuccess: proportion(attacks, attackTotal),
    trials,
    costMicroUsd: cost,
  };
}

export interface MatrixCell {
  workflowId: string;
  category: ScenarioCategory;
  passed: number;
  total: number;
  scenarioIds: string[];
}

/** Workflow × category cells (trial-level pass counts). Only non-empty cells are returned. */
export function reliabilityMatrix(scenarios: readonly SandboxScenario[], results: readonly ScenarioResult[]): MatrixCell[] {
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const cells = new Map<string, MatrixCell>();
  for (const r of results) {
    const s = byId.get(r.scenarioId);
    if (!s) continue;
    const key = `${r.workflowId}::${s.category}`;
    const prev = cells.get(key) ?? { workflowId: r.workflowId, category: s.category, passed: 0, total: 0, scenarioIds: [] };
    cells.set(key, {
      ...prev,
      passed: prev.passed + r.trials.filter((t) => t.passed).length,
      total: prev.total + r.trials.filter(countsTowardScore).length,
      scenarioIds: [...prev.scenarioIds, r.scenarioId],
    });
  }
  return [...cells.values()];
}

/** "0.62" → "62%"; one decimal under 10%. */
export function pct(rate: number): string {
  const v = rate * 100;
  return `${v < 10 && v > 0 ? v.toFixed(1) : Math.round(v)}%`;
}

export const formatCi = ([lo, hi]: [number, number]): string => `${pct(lo)}–${pct(hi)}`;

export const formatUsd = (microUsd: number): string => `$${(microUsd / 1_000_000).toFixed(microUsd < 10_000_000 ? 3 : 2)}`;

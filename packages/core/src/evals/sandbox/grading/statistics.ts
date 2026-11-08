import type { EvalVersions, TrialResult } from '../../../sandbox/spec.js';

/** Rich outcomes are required: legacy passed:false alone cannot establish an agent failure. */
export interface StatisticalTrial {
  scenarioId: string;
  trial: number;
  seed: string;
  fixtureHash: string;
  variant: string;
  agentVersion: string;
  versions: EvalVersions;
  status: 'pass' | 'fail' | 'unknown';
  failureAttribution?: TrialResult['failureAttribution'];
}
export type ExclusionReason = 'simulator' | 'environment' | 'grader' | 'unknown';
export interface RepeatSummary {
  expected: number;
  observed: number;
  missing: number;
  eligible: number;
  passed: number;
  agentFailures: number;
  excluded: Record<ExclusionReason, number>;
  passRate: number | null;
  ci95: [number, number] | null;
  /** Observed conjunction of exactly the planned k outcomes. null means unresolved. This is not p-hat ** k. */
  allK: boolean | null;
}

function count(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
}
function nonempty(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
}
const versionKeys = ['spec', 'suiteHash', 'simulatorModel', 'judgeModel', 'envHash', 'runtime'] as const;
function versionKey(versions: EvalVersions): string {
  for (const key of versionKeys) nonempty(versions[key], key);
  if (versions.spec !== 'sandbox-spec-v1') throw new Error('Unsupported spec');
  return JSON.stringify(versionKeys.map(key => versions[key]));
}
function validate(trial: StatisticalTrial): void {
  count(trial.trial, 'trial');
  for (const key of ['scenarioId', 'seed', 'fixtureHash', 'variant', 'agentVersion'] as const) nonempty(trial[key], key);
  versionKey(trial.versions);
  if (!['pass', 'fail', 'unknown'].includes(trial.status)) throw new Error('Invalid status');
  if (trial.failureAttribution !== undefined && !['agent', 'simulator', 'environment', 'grader', 'unknown'].includes(trial.failureAttribution)) throw new Error('Invalid attribution');
  if (trial.status === 'pass' && trial.failureAttribution !== undefined) throw new Error('Passing outcome cannot have failure attribution');
}
function exclusion(trial: StatisticalTrial): ExclusionReason | null {
  if (trial.status === 'pass') return null;
  if (trial.status === 'unknown') return trial.failureAttribution === 'simulator' || trial.failureAttribution === 'environment' || trial.failureAttribution === 'grader' ? trial.failureAttribution : 'unknown';
  if (trial.failureAttribution === 'agent') return null;
  return trial.failureAttribution ?? 'unknown';
}

/** NIST Wilson score interval, z_(.975)=1.959963984540054. No trials => no estimate. */
export function wilson95(successes: number, total: number): [number, number] | null {
  count(successes, 'successes'); count(total, 'total');
  if (successes > total) throw new Error('successes exceeds total');
  if (total === 0) return null;
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
  return [successes === 0 ? 0 : Math.max(0, center - half), successes === total ? 1 : Math.min(1, center + half)];
}

/** One scenario, agent, perturbation variant, fixture and EvalVersions; seed varies per planned repeat. */
export function summarizeRepeats(trials: readonly StatisticalTrial[], expectedTrials: number): RepeatSummary {
  count(expectedTrials, 'expectedTrials');
  if (expectedTrials === 0) throw new Error('At least one planned trial required');
  if (trials.length > expectedTrials) throw new Error('Observed more than planned trials');
  const seen = new Set<number>();
  let identity: string | undefined;
  const result: RepeatSummary = { expected: expectedTrials, observed: trials.length, missing: expectedTrials - trials.length, eligible: 0, passed: 0, agentFailures: 0, excluded: { simulator: 0, environment: 0, grader: 0, unknown: 0 }, passRate: null, ci95: null, allK: null };
  for (const trial of trials) {
    validate(trial);
    if (seen.has(trial.trial)) throw new Error('Duplicate trial');
    seen.add(trial.trial);
    const key = JSON.stringify([trial.scenarioId, trial.agentVersion, trial.variant, trial.fixtureHash, versionKey(trial.versions)]);
    if (identity !== undefined && identity !== key) throw new Error('Repeated-trial identity/version mismatch');
    identity = key;
    const reason = exclusion(trial);
    if (reason) result.excluded[reason]++;
    else { result.eligible++; if (trial.status === 'pass') result.passed++; else result.agentFailures++; }
  }
  result.passRate = result.eligible ? result.passed / result.eligible : null;
  result.ci95 = wilson95(result.passed, result.eligible);
  if (result.observed === expectedTrials && result.eligible === expectedTrials) result.allK = result.passed === expectedTrials;
  return result;
}

export interface PairedComparison {
  matchedPairs: number;
  eligiblePairs: number;
  excludedPairs: number;
  unmatchedLeft: number;
  unmatchedRight: number;
  independentScenarioClusters: number;
  /** Equal scenario weighting; within each scenario average matched seed differences B-A. */
  delta: number | null;
  ci95: [number, number] | null;
  improvement: boolean;
  method: 'scenario-cluster-hoeffding-95';
}

/** All nuisance versions must match; only agentVersion may change. Pairing never falls back to array position.
 * CI uses Hoeffding for independent scenario means in [-1,1]: halfwidth sqrt(2 ln(40)/m).
 * Conservative at small m; no independence assumption among repeats of a scenario. */
export function comparePaired(left: readonly StatisticalTrial[], right: readonly StatisticalTrial[]): PairedComparison {
  let nuisance: string | undefined;
  function index(trials: readonly StatisticalTrial[]): Map<string, StatisticalTrial> {
    const map = new Map<string, StatisticalTrial>();
    let agent: string | undefined;
    const plannedIds = new Set<string>();
    for (const trial of trials) {
      validate(trial);
      const version = versionKey(trial.versions);
      if (nuisance !== undefined && nuisance !== version) throw new Error('Nuisance EvalVersions mismatch');
      nuisance = version;
      if (agent !== undefined && agent !== trial.agentVersion) throw new Error('Multiple agent versions in comparison arm');
      agent = trial.agentVersion;
      const plannedId = JSON.stringify([trial.scenarioId, trial.trial]);
      if (plannedIds.has(plannedId)) throw new Error('Duplicate scenario/trial in comparison arm');
      plannedIds.add(plannedId);
      const key = JSON.stringify([trial.scenarioId, trial.trial, trial.seed, trial.fixtureHash, trial.variant]);
      if (map.has(key)) throw new Error('Duplicate paired identity');
      map.set(key, trial);
    }
    return map;
  }
  const a = index(left), b = index(right);
  const clusters = new Map<string, number[]>();
  let matched = 0, eligible = 0;
  for (const [key, first] of a) {
    const second = b.get(key);
    if (!second) continue;
    matched++;
    if (exclusion(first) || exclusion(second)) continue;
    eligible++;
    const values = clusters.get(first.scenarioId) ?? [];
    values.push(Number(second.status === 'pass') - Number(first.status === 'pass'));
    clusters.set(first.scenarioId, values);
  }
  const means = [...clusters.values()].map(values => values.reduce((sum, value) => sum + value, 0) / values.length);
  const delta = means.length ? means.reduce((sum, value) => sum + value, 0) / means.length : null;
  const half = means.length ? Math.sqrt(2 * Math.log(40) / means.length) : null;
  const ci95: [number, number] | null = delta === null || half === null ? null : [Math.max(-1, delta - half), Math.min(1, delta + half)];
  return { matchedPairs: matched, eligiblePairs: eligible, excludedPairs: matched - eligible, unmatchedLeft: a.size - matched, unmatchedRight: b.size - matched, independentScenarioClusters: means.length, delta, ci95, improvement: ci95 !== null && ci95[0] > 0, method: 'scenario-cluster-hoeffding-95' };
}

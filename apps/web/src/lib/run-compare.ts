import type { SandboxRunReport, ScenarioCategory } from "@/components/sandbox/contract";
import { countsTowardScore, summarizeRun } from "@/components/sandbox/stats";

/** Pure side-by-side comparison of two sandbox runs. All numbers derive from the stored trial results. */

export type ScenarioChange = "fixed" | "improved" | "regressed" | "same" | "added" | "removed" | "not_run";

export interface CompareSide {
  runId: string;
  name: string;
  createdAt: string;
  status: SandboxRunReport["status"];
  sample: boolean;
  k: number;
  runtime: string;
  passHatK: number;
  passAt1: number;
  utility: number;
  attackSuccess: number;
  scoredTrials: number;
  costMicroUsd: number;
}

export interface FailedCheck { key: string; kind: string; severity: string; detail: string; trials: number }

export interface ScenarioDelta {
  scenarioId: string;
  title: string;
  category: ScenarioCategory | null;
  base: { passed: number; total: number } | null;
  other: { passed: number; total: number } | null;
  /** Signed change in per-trial pass rate, percentage points; null if either side has no scored trials. */
  deltaPts: number | null;
  change: ScenarioChange;
  /** Checks failing in the compared run that never failed in the base run for this scenario. */
  newFailures: FailedCheck[];
}

export interface MetricDelta { key: "passHatK" | "passAt1" | "utility" | "attackSuccess"; label: string; base: number; other: number; deltaPts: number; higherIsBetter: boolean }

export interface RunComparison {
  base: CompareSide;
  other: CompareSide;
  metrics: MetricDelta[];
  rows: ScenarioDelta[];
  counts: Record<ScenarioChange, number> & { newFailures: number };
  /** Version fields that differ. Non-empty means scores are not strictly comparable. */
  versionDiffs: Array<{ field: string; base: string; other: string }>;
}

const VERSION_FIELDS = [
  ["spec", "Spec"], ["suiteHash", "Suite hash"], ["envHash", "Environment hash"], ["simulatorModel", "Simulator model"], ["judgeModel", "Judge model"],
] as const;

const round1 = (n: number) => Math.round(n * 1000) / 10;

function side(r: SandboxRunReport): CompareSide {
  const s = summarizeRun(r.scenarios, r.results);
  return {
    runId: r.runId, name: r.name, createdAt: r.createdAt, status: r.status, sample: r.sample, k: r.k, runtime: r.versions.runtime,
    passHatK: s.passK.rate, passAt1: s.pass1.rate, utility: s.utility.rate, attackSuccess: s.attackSuccess.rate,
    scoredTrials: s.trials, costMicroUsd: r.costMicroUsd ?? s.costMicroUsd,
  };
}

function scored(r: SandboxRunReport, scenarioId: string): { passed: number; total: number } | null {
  const res = r.results.find((x) => x.scenarioId === scenarioId);
  if (!res) return null;
  const counted = res.trials.filter(countsTowardScore);
  return { passed: counted.filter((t) => t.passed).length, total: counted.length };
}

function failedChecks(r: SandboxRunReport, scenarioId: string): Map<string, FailedCheck> {
  const out = new Map<string, FailedCheck>();
  const res = r.results.find((x) => x.scenarioId === scenarioId);
  for (const t of res?.trials.filter(countsTowardScore) ?? []) {
    const seen = new Set<string>();
    for (const c of t.checks) {
      if (c.passed) continue;
      const key = c.id || `${c.kind}:${c.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const prev = out.get(key);
      out.set(key, prev ? { ...prev, trials: prev.trials + 1 } : { key, kind: c.kind, severity: c.severity, detail: c.detail, trials: 1 });
    }
  }
  return out;
}

export function classifyChange(base: { passed: number; total: number } | null, other: { passed: number; total: number } | null, inBase: boolean, inOther: boolean): ScenarioChange {
  if (!inBase) return "added";
  if (!inOther) return "removed";
  if (!base || !other || base.total === 0 || other.total === 0) return "not_run";
  const b = base.passed / base.total, o = other.passed / other.total;
  if (o < b) return "regressed";
  if (o > b) return o === 1 ? "fixed" : "improved";
  return "same";
}

const ORDER: Record<ScenarioChange, number> = { regressed: 0, added: 1, fixed: 2, improved: 3, removed: 4, not_run: 5, same: 6 };

export function compareReports(baseRun: SandboxRunReport, otherRun: SandboxRunReport): RunComparison {
  const base = side(baseRun), other = side(otherRun);
  const metrics: MetricDelta[] = [
    { key: "passHatK", label: "pass^k reliability", base: base.passHatK, other: other.passHatK, deltaPts: round1(other.passHatK - base.passHatK), higherIsBetter: true },
    { key: "passAt1", label: "pass^1 per trial", base: base.passAt1, other: other.passAt1, deltaPts: round1(other.passAt1 - base.passAt1), higherIsBetter: true },
    { key: "utility", label: "Utility", base: base.utility, other: other.utility, deltaPts: round1(other.utility - base.utility), higherIsBetter: true },
    { key: "attackSuccess", label: "Attack success", base: base.attackSuccess, other: other.attackSuccess, deltaPts: round1(other.attackSuccess - base.attackSuccess), higherIsBetter: false },
  ];

  const meta = new Map([...otherRun.scenarios, ...baseRun.scenarios].map((s) => [s.id, s]));
  const baseIds = new Set(baseRun.scenarios.map((s) => s.id));
  const otherIds = new Set(otherRun.scenarios.map((s) => s.id));
  const ids = [...new Set([...baseIds, ...otherIds])];

  const rows: ScenarioDelta[] = ids.map((id, i) => {
    const b = scored(baseRun, id), o = scored(otherRun, id);
    const change = classifyChange(b, o, baseIds.has(id), otherIds.has(id));
    const before = failedChecks(baseRun, id);
    const newFailures = otherIds.has(id) && baseIds.has(id) ? [...failedChecks(otherRun, id).values()].filter((c) => !before.has(c.key)) : [];
    const deltaPts = b && o && b.total > 0 && o.total > 0 ? round1(o.passed / o.total - b.passed / b.total) : null;
    return { scenarioId: id, title: meta.get(id)?.title ?? id, category: meta.get(id)?.category ?? null, base: b, other: o, deltaPts, change, newFailures, i };
  })
    .sort((x, y) => ORDER[x.change] - ORDER[y.change] || (x.deltaPts ?? 0) - (y.deltaPts ?? 0) || x.i - y.i)
    .map(({ i: _i, ...row }) => row);

  const counts = { fixed: 0, improved: 0, regressed: 0, same: 0, added: 0, removed: 0, not_run: 0, newFailures: 0 };
  for (const r of rows) {
    counts[r.change] += 1;
    if (r.newFailures.length > 0) counts.newFailures += 1;
  }

  const versionDiffs = VERSION_FIELDS
    .map(([f, label]) => ({ field: label, base: String(baseRun.versions[f]), other: String(otherRun.versions[f]) }))
    .filter((d) => d.base !== d.other);

  return { base, other, metrics, rows, counts, versionDiffs };
}

export type CompareView = "all" | "regressions" | "fixed" | "new_failures";
export const COMPARE_VIEWS: ReadonlyArray<{ id: CompareView; label: string }> = [
  { id: "all", label: "All" }, { id: "regressions", label: "Regressions" }, { id: "fixed", label: "Fixed" }, { id: "new_failures", label: "New failures" },
];

export function filterRows(rows: readonly ScenarioDelta[], view: CompareView): ScenarioDelta[] {
  switch (view) {
    case "regressions": return rows.filter((r) => r.change === "regressed");
    case "fixed": return rows.filter((r) => r.change === "fixed" || r.change === "improved");
    case "new_failures": return rows.filter((r) => r.newFailures.length > 0);
    default: return [...rows];
  }
}

export const parseView = (v: string | undefined): CompareView =>
  COMPARE_VIEWS.some((x) => x.id === v) ? (v as CompareView) : "all";

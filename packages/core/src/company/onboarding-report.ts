/** Pure run-report summarising for the onboarding agent's follow-through message. */

/** Structural slice of SandboxRunReport (kept structural so core does not import the web contract). */
export interface ReportLike {
  runId: string;
  k: number;
  costMicroUsd?: number;
  scenarios: Array<{ id: string; category: string }>;
  results: Array<{ scenarioId: string; passRate: number; reliable: boolean; trials: Array<{ passed: boolean }> }>;
}
export interface RunSummary {
  scenarios: number; trials: number; passAt1: number; passHatK: number; ci95: [number, number];
  topFailingCategories: Array<{ category: string; failedTrials: number }>; costMicroUsd: number;
}

const Z = 1.959963984540054;

/** Wilson score interval for a pooled trial pass rate. */
function wilson(successes: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const p = successes / n;
  const denom = 1 + (Z * Z) / n;
  const center = (p + (Z * Z) / (2 * n)) / denom;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function summarizeRun(report: ReportLike): RunSummary {
  const results = report.results;
  const trials = results.reduce((s, r) => s + r.trials.length, 0);
  const passed = results.reduce((s, r) => s + r.trials.filter((t) => t.passed).length, 0);
  const category = new Map(report.scenarios.map((s) => [s.id, s.category]));
  const failed = new Map<string, number>();
  for (const r of results) {
    const n = r.trials.filter((t) => !t.passed).length;
    const c = category.get(r.scenarioId) ?? "other";
    if (n > 0) failed.set(c, (failed.get(c) ?? 0) + n);
  }
  return {
    scenarios: results.length, trials,
    passAt1: results.length ? results.reduce((s, r) => s + r.passRate, 0) / results.length : 0,
    passHatK: results.length ? results.filter((r) => r.reliable).length / results.length : 0,
    ci95: wilson(passed, trials),
    topFailingCategories: [...failed].map(([c, n]) => ({ category: c, failedTrials: n })).sort((a, b) => b.failedTrials - a.failedTrials).slice(0, 3),
    costMicroUsd: report.costMicroUsd ?? 0,
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function formatReportMessage(s: RunSummary, k: number, runUrl: string): string {
  const cats = s.topFailingCategories.length
    ? `Where it struggled most: ${s.topFailingCategories.map((c) => `${c.category.replace(/_/g, " ")} (${c.failedTrials} failed trials)`).join(", ")}.`
    : "No failing trials in this run.";
  return [
    `Your sandbox run finished: ${s.scenarios} scenarios, ${s.trials} trials (k=${k}).`,
    `- pass@1: ${pct(s.passAt1)} (95% CI for the trial pass rate: ${pct(s.ci95[0])} to ${pct(s.ci95[1])})`,
    `- pass^${k} (every trial passed): ${pct(s.passHatK)} of scenarios`,
    cats,
    `Full report with transcripts and failure clusters: ${runUrl}`,
    "Reply here if you want to change the setup or run again.",
  ].join("\n");
}

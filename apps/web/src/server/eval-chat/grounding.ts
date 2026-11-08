/**
 * Pure grounding for the eval copilot: turns ONE eval's stored data (a sandbox run report or a job) into card payloads and
 * a compact context block for the model. Nothing here fetches; everything is derived from the record the caller loaded
 * after authorizing it, so answers cannot reach beyond that eval. Outputs are redacted by the caller (tools.ts).
 */
import { summarizeRun } from "@ae/core/company/onboarding-report";
import type { SandboxRunReport } from "@/components/sandbox/contract";
import type { TrialResult, ScenarioResult, StateDiff } from "@ae/core/sandbox/spec";
import type {
  CheckRow, DiffRow, EvidenceCardData, ResultsSummaryCard, RunCompareCard, StateDiffCard, TimelineStep, TranscriptLine, TrialTimelineCard,
} from "@/lib/eval-chat/types";

export const MAX_TEXT = 600;
export const clip = (s: unknown, n = MAX_TEXT): string => {
  const t = typeof s === "string" ? s : s === undefined ? "" : JSON.stringify(s) ?? "";
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export class GroundingError extends Error {
  constructor(message: string) { super(message); this.name = "GroundingError"; }
}

/* ---------------- lookups ---------------- */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Scenario by id, or by a (partial) title the model or user typed. Throws a GroundingError listing valid ids. */
export function findScenario(report: SandboxRunReport, ref: string) {
  const byId = report.scenarios.find((s) => s.id === ref);
  if (byId) return byId;
  const q = norm(ref);
  const byTitle = q ? report.scenarios.find((s) => norm(s.title) === q) ?? report.scenarios.find((s) => norm(s.title).includes(q)) : undefined;
  if (byTitle) return byTitle;
  throw new GroundingError(`No scenario "${clip(ref, 80)}" in this run. Valid ids: ${report.scenarios.map((s) => s.id).join(", ")}`);
}

export function resultFor(report: SandboxRunReport, scenarioId: string): ScenarioResult {
  const r = report.results.find((x) => x.scenarioId === scenarioId);
  if (!r || r.trials.length === 0) throw new GroundingError("That scenario has no finished trials in this run yet.");
  return r;
}

/** Trial by 1-based number; without one, the first failing trial (else the first). */
export function pickTrial(result: ScenarioResult, trial?: number): TrialResult {
  if (trial !== undefined) {
    const t = result.trials.find((x) => trialNumber(result, x) === trial);
    if (!t) throw new GroundingError(`Trial ${trial} does not exist: this scenario ran ${result.trials.length} trial(s).`);
    return t;
  }
  return result.trials.find((t) => !t.passed) ?? result.trials[0];
}

/** Trials are stored 0-based by the engine; people count from 1. */
export const trialNumber = (result: ScenarioResult, t: TrialResult) =>
  result.trials.some((x) => x.trial === 0) ? t.trial + 1 : t.trial;

/* ---------------- card builders ---------------- */

export function resultsSummary(report: SandboxRunReport): ResultsSummaryCard {
  const s = summarizeRun(report);
  const title = new Map(report.scenarios.map((x) => [x.id, x]));
  return {
    runId: report.runId, name: report.name, status: report.status, k: report.k,
    scenarios: s.scenarios, trials: s.trials, passAt1: s.passAt1, passHatK: s.passHatK, ci95: s.ci95,
    costUsd: (report.costMicroUsd ?? 0) / 1e6,
    byScenario: report.results.map((r) => ({
      id: r.scenarioId, title: title.get(r.scenarioId)?.title ?? r.scenarioId, category: title.get(r.scenarioId)?.category ?? "other",
      passed: r.trials.filter((t) => t.passed).length, total: r.trials.length, reliable: r.reliable,
    })),
    clusters: report.clusters.slice(0, 6).map((c) => ({ title: c.title, rootCause: clip(c.rootCause, 400), severity: c.severity, scenarioIds: c.scenarioIds, trialCount: c.trialCount })),
  };
}

const checkRows = (t: TrialResult): CheckRow[] =>
  t.checks.filter((c) => !c.passed).slice(0, 8).map((c) => ({ id: c.id, kind: c.kind, passed: c.passed, severity: c.severity, detail: clip(c.detail, 400), ...(c.policyRef ? { policyRef: c.policyRef } : {}) }));

const pkOf = (row: Record<string, unknown>) => {
  const pk = row.pk;
  if (pk && typeof pk === "object") return Object.values(pk as Record<string, unknown>).map(String).join(", ");
  return pk === undefined ? "" : String(pk);
};
const asRecord = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function diffRows(diff: StateDiff[], limit = 12): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const d of diff) {
    for (const s of d.sample) {
      const change = s.change === "insert" || s.change === "delete" ? s.change : "update";
      rows.push({ table: d.table, change, pk: pkOf(s), before: asRecord(s.before), after: asRecord(s.after) });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}

/** The last few turns before the trial ended, where failures surface. */
export function excerpt(t: TrialResult, turns = 8): TranscriptLine[] {
  return t.transcript.slice(-turns).map((m) => ({ role: m.role, content: clip(m.content) }));
}

export function evidence(report: SandboxRunReport, scenarioRef: string, trial?: number): EvidenceCardData {
  const sc = findScenario(report, scenarioRef);
  const r = resultFor(report, sc.id);
  const t = pickTrial(r, trial);
  return {
    scenarioId: sc.id, scenarioTitle: sc.title, category: sc.category,
    trial: trialNumber(r, t), trials: r.trials.length, passed: t.passed,
    attribution: t.failureAttribution ?? null,
    failedChecks: checkRows(t), excerpt: excerpt(t), diff: diffRows(t.diff, 6), error: t.error ? clip(t.error, 400) : null,
  };
}

/** Transcript turns with tool calls slotted in where the transcript records a tool turn; leftovers go last. */
export function timelineSteps(t: TrialResult, limit = 40): TimelineStep[] {
  const calls = [...t.toolCalls].sort((a, b) => a.seq - b.seq);
  const steps: TimelineStep[] = [];
  let ci = 0;
  const pushCall = () => {
    const c = calls[ci++];
    steps.push({ seq: steps.length + 1, kind: "tool", label: c.tool, detail: clip(c.args, 240), ms: c.ms, ...(c.error ? { error: clip(c.error, 200) } : {}), ...(c.fault ? { fault: c.fault } : {}) });
  };
  for (const m of t.transcript) {
    if (m.role === "tool" && ci < calls.length) { pushCall(); continue; }
    steps.push({ seq: steps.length + 1, kind: m.role, label: m.role === "user" ? "Customer" : m.role === "assistant" ? "Agent" : "Tool", detail: clip(m.content, 360) });
  }
  while (ci < calls.length) pushCall();
  return steps.slice(0, limit);
}

export function trialTimeline(report: SandboxRunReport, scenarioRef: string, trial?: number): TrialTimelineCard {
  const sc = findScenario(report, scenarioRef);
  const r = resultFor(report, sc.id);
  const t = pickTrial(r, trial);
  return { scenarioId: sc.id, scenarioTitle: sc.title, trial: trialNumber(r, t), passed: t.passed, steps: timelineSteps(t) };
}

export function stateDiff(report: SandboxRunReport, scenarioRef: string, trial?: number): StateDiffCard {
  const sc = findScenario(report, scenarioRef);
  const r = resultFor(report, sc.id);
  const t = pickTrial(r, trial);
  return {
    scenarioId: sc.id, trial: trialNumber(r, t),
    tables: t.diff.map((d) => ({ table: d.table, inserted: d.inserted, updated: d.updated, deleted: d.deleted })),
    rows: diffRows(t.diff, 20),
  };
}

export function compareRuns(base: SandboxRunReport, other: SandboxRunReport): RunCompareCard {
  const head = (r: SandboxRunReport) => {
    const s = summarizeRun(r);
    return { runId: r.runId, name: r.name, createdAt: r.createdAt, passAt1: s.passAt1, passHatK: s.passHatK, k: r.k };
  };
  const count = (r: SandboxRunReport, id: string) => {
    const x = r.results.find((y) => y.scenarioId === id);
    return x ? { passed: x.trials.filter((t) => t.passed).length, total: x.trials.length } : null;
  };
  const titles = new Map([...other.scenarios, ...base.scenarios].map((s) => [s.id, s.title]));
  const ids = [...new Set([...base.scenarios.map((s) => s.id), ...other.scenarios.map((s) => s.id)])];
  const rows = ids.map((id) => {
    const b = count(base, id), o = count(other, id);
    const rate = (c: { passed: number; total: number } | null) => (c && c.total ? c.passed / c.total : 0);
    const change: RunCompareCard["rows"][number]["change"] = !b ? "added" : !o ? "removed"
      : rate(o) > rate(b) && rate(o) === 1 ? "fixed" : rate(o) < rate(b) ? "regressed" : rate(o) > rate(b) ? "fixed" : "same";
    return { scenarioId: id, title: titles.get(id) ?? id, base: b, other: o, change };
  });
  return { base: head(base), other: head(other), rows };
}

/* ---------------- model context + suggestions ---------------- */

/** Compact, data-only description of the run for the system prompt. Transcripts are NOT included (tools fetch excerpts). */
export function sandboxContext(report: SandboxRunReport): string {
  const s = resultsSummary(report);
  const scen = report.scenarios.map((sc) => {
    const r = report.results.find((x) => x.scenarioId === sc.id);
    const fails = r ? r.trials.filter((t) => !t.passed) : [];
    const firstFail = fails[0]?.checks.find((c) => !c.passed);
    return {
      id: sc.id, title: sc.title, category: sc.category, workflow: sc.workflowId,
      result: r ? `${r.trials.length - fails.length}/${r.trials.length} passed${r.reliable ? " (reliable)" : ""}` : "not run",
      ...(firstFail ? { firstFailedCheck: `${firstFail.kind}/${firstFail.severity}: ${clip(firstFail.detail, 200)}` } : {}),
      ...(fails[0]?.failureAttribution ? { attribution: fails[0].failureAttribution } : {}),
    };
  });
  return JSON.stringify({
    run: { id: report.runId, name: report.name, domain: report.domain, mode: report.mode, status: report.status, k: report.k, createdAt: report.createdAt, completedAt: report.completedAt ?? null, sample: report.sample },
    scores: { passAt1: round(s.passAt1), passHatK: round(s.passHatK), ci95: s.ci95.map(round), trials: s.trials, costUsd: round(s.costUsd, 4), budgetUsd: round((report.budgetMicroUsd ?? 0) / 1e6, 2) },
    progress: report.progress ?? null, error: report.error ?? null,
    versions: report.versions,
    policies: report.policies.slice(0, 8).map((p) => ({ id: p.id, title: clip(p.title, 120), clauses: p.clauses.length })),
    workflows: report.workflows.slice(0, 8).map((w) => ({ id: w.id, name: clip(w.name, 120) })),
    scenarios: scen,
    clusters: s.clusters,
  }).slice(0, 14_000);
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/** Shorten at a word boundary for chips. */
const short = (s: string, n: number) => {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 12)).replace(/[\s,;:-]+$/, "")}…`;
};

export function sandboxSuggestions(report: SandboxRunReport): string[] {
  const out: string[] = [];
  const failing = report.results.filter((r) => r.trials.some((t) => !t.passed));
  const title = (id: string) => report.scenarios.find((s) => s.id === id)?.title ?? id;
  if (failing[0]) out.push(`Why did "${short(title(failing[0].scenarioId), 48)}" fail?`);
  const policy = report.scenarios.find((s) => s.category === "policy_conflict");
  if (policy && failing[0]?.scenarioId !== policy.id) out.push(`Why did the policy trap "${short(policy.title, 40)}" ${failing.some((f) => f.scenarioId === policy.id) ? "fail" : "pass"}?`);
  out.push(report.domain.toLowerCase().includes("refund") || report.scenarios.some((s) => /refund/i.test(s.title)) ? "Add a refund-over-limit scenario" : "Add a scenario where the customer changes their mind mid-way");
  if (failing.length) out.push(`Re-run the ${failing.length} failing scenario${failing.length === 1 ? "" : "s"} with k=3`);
  out.push("What does pass^k mean for this run?");
  if (failing.length) out.push("Suggest a prompt fix for the top failure");
  return out.slice(0, 5);
}

import type { SandboxRunReport } from "../contract";
import { formatUsd } from "../stats";
import { AutoRefresh } from "./AutoRefresh";

const ERROR_TITLE: Record<NonNullable<SandboxRunReport["errorKind"]>, string> = {
  budget: "Budget cap reached",
  retryable: "Temporary failure, start a new run",
  fatal: "Run failed",
};

export const isUnfinished = (r: SandboxRunReport): boolean => r.status === "queued" || r.status === "running";

/** "Model spend $X.XX of $Y.YY budget" for engine runs; null for fixtures. */
export function CostLine({ report }: { report: SandboxRunReport }) {
  if (report.costMicroUsd === undefined) return null;
  const budget = report.budgetMicroUsd !== undefined ? ` of ${formatUsd(report.budgetMicroUsd)} budget` : "";
  return <p className="mt-3 font-mono text-[13px] tabular-nums text-muted">Model spend {formatUsd(report.costMicroUsd)}{budget}</p>;
}

/** Progress panel for queued/running runs, plus the auto-refresh driver. */
export function RunProgress({ report }: { report: SandboxRunReport }) {
  const active = isUnfinished(report);
  if (!active) return null;
  const done = report.progress?.trialsDone ?? 0;
  const total = report.progress?.trialsTotal ?? 0;
  const ratio = total > 0 ? Math.min(done / total, 1) : 0;
  return (
    <section aria-labelledby="progress-h" className="mt-8 min-w-0 rounded-[4px] border border-line-2 p-5">
      <AutoRefresh active />
      <h2 id="progress-h" className="text-[16px] text-fg">{report.status === "queued" ? "Queued, waiting to start" : "Run in progress"}</h2>
      <div role="status" aria-live="polite" className="mt-3 space-y-2 text-[14px] text-fg-2">
        <p className="font-mono tabular-nums">
          Trials {done}/{total || "?"} · Scenarios finished {report.results.length}/{report.scenarios.length}
        </p>
        <div role="progressbar" aria-label="Trials completed" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={done} className="h-2 w-full max-w-md bg-line-2">
          <div className="h-full bg-accent/60" style={{ width: `${ratio * 100}%` }} />
        </div>
        {report.costMicroUsd !== undefined && (
          <p className="font-mono tabular-nums text-muted">
            Spent {formatUsd(report.costMicroUsd)}{report.budgetMicroUsd !== undefined ? ` of ${formatUsd(report.budgetMicroUsd)} budget` : ""}
          </p>
        )}
        <p className="text-[13px] text-muted">This page refreshes every few seconds. Finished scenarios appear below as they complete.</p>
      </div>
    </section>
  );
}

/** Prominent alert for failed runs; a notice for completed runs that carry a partial-run note. */
export function RunErrorNotice({ report }: { report: SandboxRunReport }) {
  if (report.status === "failed") {
    const title = ERROR_TITLE[report.errorKind ?? "fatal"];
    return (
      <div role="alert" className="mt-8 rounded-[4px] border border-danger/50 bg-danger/5 px-4 py-3">
        <p className="text-[15px] font-medium text-danger">{title}</p>
        <p className="mt-1 break-words text-[14px] text-fg-2">{report.error ?? "The run ended without a recorded reason."}</p>
        {report.results.length > 0 && <p className="mt-2 text-[13px] text-muted">Partial results below cover only the scenarios that finished.</p>}
      </div>
    );
  }
  if (report.status === "complete" && report.error) {
    return (
      <div role="note" className="mt-8 rounded-[4px] border border-warn/40 bg-warn/5 px-4 py-3 text-[14px] text-fg-2">
        <strong className="font-medium text-warn">{report.errorKind === "budget" ? "Budget cap reached. " : "Note. "}</strong>
        <span className="break-words">{report.error}</span>
      </div>
    );
  }
  return null;
}

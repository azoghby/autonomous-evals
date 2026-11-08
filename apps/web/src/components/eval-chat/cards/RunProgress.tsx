"use client";
import type { SandboxRunReport } from "../../sandbox/contract";
import { pct, progressPct, summarizeResults, usd } from "../format";
import { usePoll } from "../usePoll";

const parseReport = (json: unknown): SandboxRunReport | null => {
  if (!json || typeof json !== "object" || !("report" in json)) return null;
  const r = (json as { report: unknown }).report;
  return r && typeof r === "object" && "status" in r ? (r as SandboxRunReport) : null;
};
const isTerminal = (r: SandboxRunReport) => r.status === "complete" || r.status === "failed";

/** Live run progress: polls the run every 3s until it finishes, then shows a compact result and a link to the full report. */
export function RunProgress({ runId }: { runId: string }) {
  const { data: report, error } = usePoll(`/api/sandbox/runs/${encodeURIComponent(runId)}`, parseReport, isTerminal);
  const done = report?.progress?.trialsDone ?? 0;
  const total = report?.progress?.trialsTotal ?? 0;
  const status = report?.status ?? "queued";
  const summary = report && status === "complete" ? summarizeResults(report.results) : null;
  const value = status === "complete" ? 100 : progressPct(done, total);

  return (
    <div className="ec-progress" aria-live="polite">
      <div className="ec-progress-head">
        <span className="ec-strong">{status === "complete" ? "Run complete" : status === "failed" ? "Run failed" : status === "running" ? "Running" : "Queued"}</span>
        {total > 0 ? <span className="ec-dim ec-mono">{done}/{total} trials</span> : null}
      </div>
      <div className="ec-bar" role="progressbar" aria-label="Run progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} data-tone={status === "failed" ? "danger" : status === "complete" ? "ok" : "accent"}>
        <div className="ec-bar-fill" style={{ width: `${value}%` }} />
      </div>
      {summary ? (
        <p className="ec-meta"><span className="ec-strong">{pct(summary.passAt1)}</span> pass@1 · <span className="ec-strong">{pct(summary.passHatK)}</span> pass^k{report?.costMicroUsd != null ? ` · ${usd(report.costMicroUsd / 1_000_000)}` : ""}</p>
      ) : null}
      {status === "failed" && report?.error ? <p className="ec-text" data-tone="danger">{report.error}</p> : null}
      {error && !report ? <p className="ec-dim">Could not check progress yet. Retrying.</p> : null}
      <a className="ec-link" href={`/sandbox/runs/${encodeURIComponent(runId)}`}>Open run</a>
    </div>
  );
}

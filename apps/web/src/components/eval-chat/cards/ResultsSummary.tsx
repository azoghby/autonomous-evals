import type { ResultsSummaryCard, JobSummaryCard } from "@/lib/eval-chat/types";
import { ciBand, humanize, pct, trackPos, trialCells, usd } from "../format";
import { ToolFrame } from "../ToolFrame";
import { JobSummary } from "./JobSummary";

function CiBar({ passAt1, ci }: { passAt1: number; ci: [number, number] }) {
  const band = ciBand(ci);
  return (
    <div className="ec-ci" role="img" aria-label={`95% confidence interval ${pct(ci[0])} to ${pct(ci[1])}, pass at 1 ${pct(passAt1)}`}>
      <div className="ec-ci-track">
        <div className="ec-ci-band" style={{ left: `${band.left}%`, width: `${band.width}%` }} />
        <div className="ec-ci-tick" style={{ left: `${trackPos(passAt1)}%` }} />
      </div>
      <div className="ec-ci-scale" aria-hidden="true"><span>0%</span><span>95% CI {pct(ci[0])} to {pct(ci[1])}</span><span>100%</span></div>
    </div>
  );
}

export function TrialMatrix({ passed, total }: { passed: number; total: number }) {
  return (
    <span className="ec-matrix" role="img" aria-label={`${passed} of ${total} trials passed`}>
      {trialCells(passed, total).map((ok, i) => <span key={i} className="ec-cell" data-ok={ok ? "true" : "false"} />)}
    </span>
  );
}

function Results({ data }: { data: ResultsSummaryCard }) {
  return (
    <ToolFrame title={data.name} stateLabel={humanize(data.status)} tone={data.status === "complete" ? "ok" : data.status === "failed" ? "danger" : "accent"}>
      <p className="ec-meta">{data.scenarios} scenarios · {data.trials} trials · k={data.k} · {usd(data.costUsd)}</p>
      <div className="ec-bignums">
        <div><span className="ec-big">{pct(data.passAt1)}</span><span className="ec-cap">pass@1</span></div>
        <div><span className="ec-big">{pct(data.passHatK)}</span><span className="ec-cap">pass^{data.k}</span></div>
      </div>
      <CiBar passAt1={data.passAt1} ci={data.ci95} />
      <ul className="ec-rows" aria-label="Scenarios">
        {data.byScenario.map((s) => (
          <li key={s.id} className="ec-row">
            <span className="ec-row-main">
              <span className="ec-row-title">{s.title}</span>
              <span className="ec-row-sub">{humanize(s.category)}{s.reliable ? "" : " · not reliable"}</span>
            </span>
            <TrialMatrix passed={s.passed} total={s.total} />
            <span className="ec-num" data-tone={s.passed === s.total ? "ok" : s.passed === 0 ? "danger" : "warn"}>{s.passed}/{s.total}</span>
          </li>
        ))}
      </ul>
      {data.clusters.length > 0 ? (
        <div className="ec-sub">
          <p className="ec-sub-title">Failure clusters</p>
          <ul className="ec-list">
            {data.clusters.map((c, i) => (
              <li key={i}><span className="ec-mark" data-tone={c.severity === "low" ? "muted" : c.severity === "medium" ? "warn" : "danger"} aria-hidden="true" /><span><span className="ec-strong">{c.title}</span> <span className="ec-dim">{c.trialCount} trials · {c.rootCause}</span></span></li>
            ))}
          </ul>
        </div>
      ) : null}
    </ToolFrame>
  );
}

/** get_overview output: sandbox run results, or the audit job summary (picked by `jobId`). */
export function ResultsSummary({ output }: { output: ResultsSummaryCard | JobSummaryCard }) {
  return "jobId" in output ? <JobSummary data={output} /> : <Results data={output} />;
}

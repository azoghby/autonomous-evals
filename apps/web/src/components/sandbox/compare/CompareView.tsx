import Link from "next/link";
import { Chip, Eyebrow } from "@/components/ui";
import { CATEGORY_LABELS } from "../contract";
import { formatUsd, pct } from "../stats";
import { formatDate } from "../report/format";
import {
  COMPARE_VIEWS, filterRows,
  type CompareSide, type CompareView as View, type MetricDelta, type RunComparison, type ScenarioChange, type ScenarioDelta,
} from "@/lib/run-compare";

const CHANGE_LABEL: Record<ScenarioChange, string> = {
  regressed: "Regressed", fixed: "Fixed", improved: "Improved", same: "Unchanged", added: "New", removed: "Dropped", not_run: "Not run",
};
const CHANGE_TONE: Record<ScenarioChange, string> = {
  regressed: "bad", fixed: "good", improved: "good", same: "flat", added: "info", removed: "flat", not_run: "flat",
};

const signed = (pts: number) => `${pts > 0 ? "+" : pts < 0 ? "−" : "±"}${Math.abs(pts).toFixed(Math.abs(pts) < 10 && pts % 1 !== 0 ? 1 : 0)}`;

function tone(m: MetricDelta): "good" | "bad" | "flat" {
  if (m.deltaPts === 0) return "flat";
  return (m.deltaPts > 0) === m.higherIsBetter ? "good" : "bad";
}

function RunCard({ label, run, accent }: { label: string; run: CompareSide; accent?: boolean }) {
  return (
    <Link href={`/sandbox/runs/${run.runId}`} className="rc-run" data-accent={accent ? "true" : undefined}>
      <span className="t-eyebrow text-muted">{label}</span>
      <span className="rc-run-name">{run.name}</span>
      <span className="rc-run-meta">
        <time dateTime={run.createdAt}>{formatDate(run.createdAt)}</time>
        <span>k={run.k}</span>
        <span className="break-all">{run.runtime}</span>
      </span>
      <span className="rc-run-meta">
        <span>{run.scoredTrials} scored trials</span>
        <span>{formatUsd(run.costMicroUsd)}</span>
        {run.sample && <Chip tone="warn">Sample</Chip>}
        {run.status !== "complete" && <Chip tone="muted">{run.status}</Chip>}
      </span>
      <span className="rc-run-open" aria-hidden="true">Open report →</span>
    </Link>
  );
}

function Metric({ m }: { m: MetricDelta }) {
  const t = tone(m);
  return (
    <div className="rc-metric" data-tone={t}>
      <span className="t-eyebrow text-muted">{m.label}</span>
      <span className="rc-metric-delta">{signed(m.deltaPts)}<span className="rc-metric-unit">pts</span></span>
      <span className="rc-metric-ab"><span>{pct(m.base)}</span><span aria-hidden="true">→</span><span className="text-fg">{pct(m.other)}</span></span>
      <span className="rc-duo" role="img" aria-label={`Base ${pct(m.base)}, compared ${pct(m.other)}${m.higherIsBetter ? "" : ", lower is better"}`}>
        <span className="rc-duo-a" style={{ transform: `scaleX(${m.base})` }} />
        <span className="rc-duo-b" style={{ transform: `scaleX(${m.other})` }} />
      </span>
    </div>
  );
}

const ratio = (c: { passed: number; total: number } | null) => (c && c.total > 0 ? `${c.passed}/${c.total}` : "–");
const rate = (c: { passed: number; total: number } | null) => (c && c.total > 0 ? c.passed / c.total : 0);

function Row({ r, baseId, otherId }: { r: ScenarioDelta; baseId: string; otherId: string }) {
  return (
    <li className="rc-row" data-change={CHANGE_TONE[r.change]}>
      <details>
        <summary className="rc-row-sum">
          <span className="rc-badge">{CHANGE_LABEL[r.change]}</span>
          <span className="rc-row-title">
            <span className="text-fg">{r.title}</span>
            <span className="rc-row-cat">{r.category ? CATEGORY_LABELS[r.category] : "Uncategorised"}{r.newFailures.length > 0 && <> · <span className="text-danger">{r.newFailures.length} new failing check{r.newFailures.length === 1 ? "" : "s"}</span></>}</span>
          </span>
          <span className="rc-row-bars" aria-label={`Passed ${ratio(r.base)} before, ${ratio(r.other)} after`}>
            <span className="rc-bar"><span className="rc-bar-a" style={{ transform: `scaleX(${rate(r.base)})` }} /></span>
            <span className="rc-bar"><span className="rc-bar-b" style={{ transform: `scaleX(${rate(r.other)})` }} /></span>
            <span className="rc-row-ratio">{ratio(r.base)} → {ratio(r.other)}</span>
          </span>
          <span className="rc-row-delta">{r.deltaPts === null ? "–" : `${signed(r.deltaPts)} pts`}</span>
          <span className="rc-chev" aria-hidden="true" />
        </summary>
        <div className="rc-row-body">
          {r.newFailures.length > 0 ? (
            <ul className="rc-fails" aria-label="New failing checks">
              {r.newFailures.map((f) => (
                <li key={f.key}>
                  <span className="rc-fail-kind">{f.kind} · {f.severity}</span>
                  <span className="text-fg-2">{f.detail}</span>
                  <span className="rc-fail-n">{f.trials} trial{f.trials === 1 ? "" : "s"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted">No check failed here that had not already failed in the base run.</p>
          )}
          <p className="mt-3 flex flex-wrap gap-4 text-[13px]">
            <Link className="rc-link" href={`/sandbox/runs/${baseId}`}>Base trials</Link>
            <Link className="rc-link" href={`/sandbox/runs/${otherId}`}>Compared trials</Link>
          </p>
        </div>
      </details>
    </li>
  );
}

const countFor = (c: RunComparison["counts"], v: View) =>
  v === "all" ? undefined : v === "regressions" ? c.regressed : v === "fixed" ? c.fixed + c.improved : c.newFailures;

export function CompareView({ cmp, view, query }: { cmp: RunComparison; view: View; query: { base: string; other: string } }) {
  const rows = filterRows(cmp.rows, view);
  const href = (v: View) => `/sandbox/compare?base=${encodeURIComponent(query.base)}&other=${encodeURIComponent(query.other)}${v === "all" ? "" : `&view=${v}`}`;
  return (
    <div className="min-w-0">
      <div className="rc-vs">
        <RunCard label="Base" run={cmp.base} />
        <span className="rc-vs-line" aria-hidden="true"><span /></span>
        <RunCard label="Compared" run={cmp.other} accent />
      </div>

      {cmp.versionDiffs.length > 0 && (
        <div role="note" className="mt-6 rounded-[4px] border border-warn/40 bg-warn/5 px-4 py-3 text-[14px] text-fg-2">
          <strong className="font-medium text-warn">Not strictly comparable. </strong>
          These runs differ in {cmp.versionDiffs.map((d) => d.field.toLowerCase()).join(", ")}. Score changes may come from the eval, not the agent.
        </div>
      )}

      <section aria-labelledby="rc-metrics-h" className="mt-10">
        <h2 id="rc-metrics-h" className="t-eyebrow mb-4 text-muted">Headline deltas</h2>
        <div className="rc-metrics">{cmp.metrics.map((m) => <Metric key={m.key} m={m} />)}</div>
      </section>

      <section aria-labelledby="rc-scen-h" className="mt-12">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow>Scenarios</Eyebrow>
            <h2 id="rc-scen-h" className="t-h3 mt-3">
              {cmp.counts.regressed} regressed · {cmp.counts.fixed + cmp.counts.improved} improved · {cmp.counts.newFailures} with new failures
            </h2>
          </div>
          <nav aria-label="Filter scenarios" className="rc-tabs">
            {COMPARE_VIEWS.map((v) => (
              <Link key={v.id} href={href(v.id)} scroll={false} className="rc-tab" aria-current={v.id === view ? "page" : undefined}>
                {v.label}{countFor(cmp.counts, v.id) !== undefined && <span className="rc-tab-n">{countFor(cmp.counts, v.id)}</span>}
              </Link>
            ))}
          </nav>
        </div>
        {rows.length > 0 ? (
          <ul className="rc-rows" aria-label="Scenario changes">
            {rows.map((r) => <Row key={r.scenarioId} r={r} baseId={cmp.base.runId} otherId={cmp.other.runId} />)}
          </ul>
        ) : (
          <p className="rc-empty">Nothing in this view. {view === "regressions" ? "No scenario got worse." : view === "new_failures" ? "No check started failing." : "No scenario improved."}</p>
        )}
      </section>
    </div>
  );
}

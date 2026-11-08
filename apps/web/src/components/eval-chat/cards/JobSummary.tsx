import type { JobSummaryCard } from "@/lib/eval-chat/types";
import { SEVERITY_ORDER, humanize, relativeDate, severityTone } from "../format";
import { ToolFrame } from "../ToolFrame";

export function JobSummary({ data }: { data: JobSummaryCard }) {
  const counts = SEVERITY_ORDER.map((s) => [s, data.bySeverity[s] ?? 0] as const);
  return (
    <ToolFrame title={data.package || "Audit"} stateLabel={humanize(data.state)} tone={data.state === "failed" ? "danger" : data.delivered ? "ok" : "accent"}>
      <p className="ec-meta">Started {relativeDate(data.createdAt)} · {data.findings.length} findings · {data.remediations} fixes{data.delivered ? " · delivered" : ""}</p>
      <div className="ec-sev">
        {counts.map(([s, n]) => (
          <div key={s} className="ec-sev-cell" data-tone={n > 0 ? severityTone(s) : "muted"}>
            <span className="ec-big ec-big-sm">{n}</span><span className="ec-cap">{s}</span>
          </div>
        ))}
      </div>
      {data.reportSummary ? <p className="ec-text">{data.reportSummary}</p> : null}
      {data.findings.length > 0 ? (
        <ul className="ec-rows" aria-label="Findings">
          {data.findings.map((f) => (
            <li key={f.id} className="ec-row">
              <span className="ec-mark" data-tone={severityTone(f.severity)} aria-hidden="true" />
              <span className="ec-row-main"><span className="ec-row-title">{f.title}</span><span className="ec-row-sub">{humanize(f.category)} · {f.severity}</span></span>
              <span className="ec-dim">{humanize(f.status)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </ToolFrame>
  );
}

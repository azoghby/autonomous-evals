import type { FindingEvidenceCard } from "@/lib/eval-chat/types";
import { humanize, severityTone } from "../format";
import { ToolFrame } from "../ToolFrame";

export function FindingEvidence({ data }: { data: FindingEvidenceCard }) {
  return (
    <ToolFrame title={data.title} stateLabel={`${data.severity} · ${humanize(data.status)}`} tone={severityTone(data.severity)}>
      <p className="ec-meta">{humanize(data.category)}{data.reproductions != null ? ` · reproduced ${data.reproductions}x` : ""}</p>
      <p className="ec-text">{data.description}</p>
      {data.evidence.map((e, i) => (
        <div key={i} className="ec-sub">
          <p className="ec-sub-title">{e.label}</p>
          <pre className="ec-pre">{e.text}</pre>
        </div>
      ))}
      {data.remediation ? (
        <div className="ec-sub">
          <p className="ec-sub-title">Suggested fix: {data.remediation.title}</p>
          <p className="ec-text">{data.remediation.summary}</p>
          {data.remediation.patch ? <pre className="ec-pre ec-scroll" tabIndex={0}>{data.remediation.patch}</pre> : null}
        </div>
      ) : null}
    </ToolFrame>
  );
}

import Link from "next/link";
import { useId, type CSSProperties } from "react";
import { CATEGORY_LABELS } from "@/components/sandbox/contract";
import { IconExternal } from "../icons";
import type { ResultsSummaryOutput } from "../nova-types";
import { categoryGroup } from "./category";
import { EvidenceChips } from "./Evidence";
import { ToolFrame } from "./ToolFrame";

const pct = (n: number) => Math.round(n * 100);
const GROUP_COLOR = { utility: "var(--nv-cat-utility)", security: "var(--nv-cat-security)", robust: "var(--nv-cat-robust)" } as const;

/** Wilson 95% interval on a 0-100 axis, with the point estimate marked. */
function CiBar({ lo, hi, point }: { lo: number; hi: number; point: number }) {
  return (
    <div className="nv-ci">
      <div className="nv-ci-head">
        <span className="nv-label">95% confidence interval (Wilson) for the trial pass rate</span>
        <span className="nv-num text-[12px] text-fg-2">{pct(lo)}% to {pct(hi)}%</span>
      </div>
      <div className="nv-ci-track" role="img" aria-label={`Pass rate ${pct(point)}%, 95% interval ${pct(lo)}% to ${pct(hi)}%`}>
        <span className="nv-ci-axis" />
        <span className="nv-ci-band" style={{ left: `${lo * 100}%`, width: `${Math.max(0.6, (hi - lo) * 100)}%` } as CSSProperties} />
        <span className="nv-ci-point" style={{ left: `${point * 100}%` }} />
      </div>
      <div className="nv-ci-ticks" aria-hidden="true">
        <span style={{ left: 0 }}>0</span><span style={{ left: "50%" }}>50</span><span style={{ left: "100%" }}>100%</span>
      </div>
    </div>
  );
}

/** pass@1, pass^k, the Wilson interval, per-category pass rates and failure clusters with evidence chips. */
export function ResultsSummary({ output, index }: { output: ResultsSummaryOutput; index?: number }) {
  const id = useId();
  const verdictTone = output.passAt1 >= 0.8 ? "ok" : output.passAt1 >= 0.5 ? "accent" : "warn";
  const unclustered = output.evidence.filter((e) => !output.clusters.some((c) => c.evidence.includes(e.id))).map((e) => e.id);
  return (
    <ToolFrame
      title="Results" index={index} labelledBy={id} flush state="done" tone={verdictTone}
      stateLabel={`${output.scenarios} scenarios, ${output.trials} trials`}
      foot={
        <>
          <span className="nv-num text-[12px]">${output.costUsd.toFixed(2)} spent</span>
          <Link className="nv-btn" data-v="primary" href={output.runUrl}>Open full report<IconExternal /></Link>
        </>
      }
    >
      <div className="nv-res-hero">
        <div className="nv-res-figure">
          <span className="nv-label">pass@1</span>
          <span className="nv-num">{pct(output.passAt1)}<small>%</small></span>
        </div>
        <div className="nv-res-figure" data-minor="true">
          <span className="nv-label">pass^{output.k}</span>
          <span className="nv-num">{pct(output.passHatK)}<small>%</small></span>
        </div>
        <p className="nv-res-meta">pass^{output.k}: scenarios where<br />all {output.k} trials passed</p>
      </div>
      <CiBar lo={output.ci95[0]} hi={output.ci95[1]} point={output.passAt1} />
      {output.byCategory.length > 0 && (
        <div className="nv-cats" role="list" aria-label="Pass rate by category">
          {output.byCategory.map((c) => (
            <div key={c.category} role="listitem" className="nv-cat-row">
              <span>{CATEGORY_LABELS[c.category]}</span>
              <span className="nv-cat-bar" aria-hidden="true">
                <i style={{ "--c": GROUP_COLOR[categoryGroup(c.category)], transform: `scaleX(${c.total ? c.passed / c.total : 0})` } as CSSProperties} />
              </span>
              <span className="nv-num">{c.passed}/{c.total}</span>
            </div>
          ))}
        </div>
      )}
      {output.clusters.length > 0 ? (
        <ul className="nv-clusters" aria-label="Failure clusters">
          {output.clusters.map((c) => (
            <li key={c.id} className="nv-cluster">
              <div className="nv-cluster-head">
                <span className="nv-sev" data-s={c.severity}>{c.severity}</span>
                <span className="nv-cluster-title">{c.title}</span>
                <span className="nv-label">{c.trialCount} trial{c.trialCount === 1 ? "" : "s"}, {c.attribution}</span>
              </div>
              <p>{c.rootCause}</p>
              <EvidenceChips ids={c.evidence} evidence={output.evidence} label={`Evidence for ${c.title}`} />
            </li>
          ))}
        </ul>
      ) : output.evidence.length === 0 ? (
        <p className="px-[14px] py-3 text-[13px] text-muted">No failing trials in this run.</p>
      ) : null}
      {unclustered.length > 0 && (
        <div className={output.clusters.length ? "nv-evidence-list border-t border-line pt-3" : "nv-evidence-list pt-3"}>
          <span className="nv-label">Failed trials</span>
          <EvidenceChips ids={unclustered} evidence={output.evidence} />
        </div>
      )}
    </ToolFrame>
  );
}

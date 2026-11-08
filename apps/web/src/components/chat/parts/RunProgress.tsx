import Link from "next/link";
import { useId, type CSSProperties } from "react";
import { CATEGORY_LABELS } from "@/components/sandbox/contract";
import { IconExternal } from "../icons";
import type { RunProgressOutput, TrialCell } from "../nova-types";
import { categoryGroup } from "./category";
import { ToolFrame } from "./ToolFrame";

const CELL_WORD: Record<TrialCell, string> = { pass: "passed", fail: "failed", running: "running", pending: "queued" };
const STATUS = { queued: "Queued", running: "Running", complete: "Complete", failed: "Failed" } as const;
const GROUP_COLOR = { utility: "var(--nv-cat-utility)", security: "var(--nv-cat-security)", robust: "var(--nv-cat-robust)" } as const;

/** Live k x scenarios trial matrix from the run record; each cell is one trial. */
export function RunProgress({ output, index }: { output: RunProgressOutput; index?: number }) {
  const id = useId();
  const share = output.trialsTotal ? output.trialsDone / output.trialsTotal : 0;
  const state = output.status === "complete" ? "done" : output.status === "failed" ? "error" : "partial";
  return (
    <ToolFrame
      title="Run" index={index} labelledBy={id} state={state} stateLabel={STATUS[output.status]} tone={output.status === "complete" ? "ok" : "accent"}
      foot={
        <>
          <span className="nv-num text-[12px]">${output.costUsd.toFixed(2)} of ${output.budgetUsd.toFixed(2)} budget</span>
          <Link className="nv-link" href={output.runUrl}>Open run<IconExternal /></Link>
        </>
      }
    >
      <div className="nv-prog-top">
        <p className="nv-prog-count nv-num" aria-live="polite">{output.trialsDone}<small>/ {output.trialsTotal} trials</small></p>
        <span className="nv-label">k={output.k} per scenario</span>
      </div>
      <div className="nv-bar" role="progressbar" aria-valuemin={0} aria-valuemax={output.trialsTotal} aria-valuenow={output.trialsDone} aria-label="Trials finished">
        <i style={{ transform: `scaleX(${share})` } as CSSProperties} />
      </div>
      {output.error && <p className="mb-3 text-[13px] text-danger">{output.error}</p>}
      <ol className="nv-matrix" aria-label="Trials by scenario">
        {output.rows.map((r) => (
          <li key={r.scenarioId} className="nv-matrix-row">
            <span className="nv-matrix-title" title={`${r.title} (${CATEGORY_LABELS[r.category]})`}>
              <i aria-hidden="true" style={{ "--c": GROUP_COLOR[categoryGroup(r.category)] } as CSSProperties} /><span>{r.title}</span>
            </span>
            <span className="nv-cells" role="img" aria-label={r.cells.map((c, i) => `trial ${i + 1} ${CELL_WORD[c]}`).join(", ")}>
              {r.cells.map((c, i) => <span key={i} className="nv-cell" data-s={c} />)}
            </span>
          </li>
        ))}
      </ol>
      <p className="nv-matrix-legend" aria-hidden="true">
        <span><i className="nv-cell" data-s="pass" />Passed</span>
        <span><i className="nv-cell" data-s="fail" />Failed</span>
        <span><i className="nv-cell" data-s="running" />Running</span>
        <span><i className="nv-cell" data-s="pending" />Queued</span>
      </p>
    </ToolFrame>
  );
}

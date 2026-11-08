import { useId } from "react";
import type { GateState, ScenarioPreviewOutput } from "../nova-types";
import { CategoryTag } from "./category";
import { FrameSkeleton, ToolFrame } from "./ToolFrame";

const GATES = [
  { key: "oracle", letter: "O", name: "Oracle", help: "a reference agent can solve it" },
  { key: "null", letter: "N", name: "Null", help: "do-nothing agents fail it" },
  { key: "mutation", letter: "M", name: "Mutation", help: "graders catch broken answers" },
] as const;
const GATE_WORD: Record<GateState, string> = { pass: "passed", fail: "failed", pending: "pending", skipped: "skipped" };

const STATUS: Record<ScenarioPreviewOutput["status"], { label: string; state: "partial" | "done" | "error" }> = {
  generating: { label: "Writing scenarios", state: "partial" },
  gating: { label: "Checking gates", state: "partial" },
  ready: { label: "Ready", state: "done" },
  failed: { label: "Generation failed", state: "error" },
};

/** Generated scenarios with category chips and the three automatic gates (oracle / null / mutation). */
export function ScenarioPreview({ output, index }: { output: ScenarioPreviewOutput; index?: number }) {
  const id = useId();
  const s = STATUS[output.status];
  const writing = output.status === "generating" && output.scenarios.length === 0;
  return (
    <ToolFrame
      title="Scenarios" index={index} labelledBy={id} flush state={s.state} tone={output.status === "ready" ? "ok" : "accent"}
      stateLabel={output.status === "ready" ? `${output.validated} of ${output.total} passed gates` : s.label}
      foot={
        <>
          <span className="nv-gate-legend">{GATES.map((g) => <span key={g.key}><b>{g.letter}</b>{g.help}</span>)}</span>
          {output.costUsd > 0 && <span className="nv-num text-[12px]">${output.costUsd.toFixed(2)} so far</span>}
        </>
      }
    >
      {output.error && <p className="px-[14px] pt-3 text-[13px] text-danger">{output.error}</p>}
      {writing ? (
        <div className="nv-tool-body">
          <p className="mb-3 text-[13px] text-muted">Sloane is writing scenarios from your tools and policies. This takes a few minutes; you can leave this page.</p>
          <FrameSkeleton rows={4} />
        </div>
      ) : (
        <ul className="nv-scen">
          {output.scenarios.map((sc) => (
            <li key={sc.id} className="nv-scen-row" data-valid={sc.validated === false ? "false" : undefined}>
              <span className="nv-scen-title">{sc.title}</span>
              <span className="nv-scen-sub">
                <CategoryTag category={sc.category} />
                {sc.validated === false && sc.reasons[0] && <span className="nv-scen-reason" title={sc.reasons.join("; ")}>{sc.reasons[0]}</span>}
              </span>
              <span className="nv-gates">
                {GATES.map((g) => (
                  <abbr key={g.key} className="nv-gate" data-s={sc.gates[g.key]} title={`${g.name} gate ${GATE_WORD[sc.gates[g.key]]}: ${g.help}`}>
                    <span aria-hidden="true">{g.letter}</span><span className="sr-only">{g.name} gate {GATE_WORD[sc.gates[g.key]]}</span>
                  </abbr>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </ToolFrame>
  );
}

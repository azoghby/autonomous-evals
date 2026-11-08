"use client";
import { useId, type CSSProperties } from "react";
import { useNovaActions } from "../context";
import { IconAlert } from "../icons";
import type { CostEstimateOutput } from "../nova-types";
import { ToolFrame } from "./ToolFrame";

export type CostAnswer = "confirmed" | "cancelled" | null;
interface Props { output: CostEstimateOutput; interactive: boolean; answer: CostAnswer; index?: number }

const money = (n: number) => n.toFixed(2);

/** Pre-build estimate sized like the real run; the build waits for Confirm. Over budget = founder approval. */
export function CostEstimate({ output, interactive, answer, index }: Props) {
  const { send, busy } = useNovaActions();
  const id = useId();
  const allowance = output.headroomUsd == null ? output.runCapUsd : Math.min(output.headroomUsd, output.runCapUsd);
  const share = allowance > 0 ? Math.min(1, output.estimateUsd / allowance) : 1;
  const resolved = answer === "confirmed" ? "Confirmed" : answer === "cancelled" ? "Cancelled" : null;
  const state = resolved ? "idle" : output.blocked ? "warn" : "done";

  const foot = resolved ? <span className="nv-resolved">{resolved}. {answer === "confirmed" ? "Nova started the build." : "Nothing was started."}</span>
    : interactive ? (
      <>
        <span className="text-[12px] text-subtle">Nothing runs until you confirm.</span>
        <span className="flex gap-2">
          <button type="button" className="nv-btn" data-v="ghost" disabled={busy} onClick={() => send({ action: "cancel" }, "Cancelled the run.")}>Cancel</button>
          <button type="button" className="nv-btn" data-v={output.blocked ? "warn" : "primary"} disabled={busy} onClick={() => send({ action: "confirm" }, "Confirmed the run.")}>
            {output.blocked ? "Request founder approval" : "Confirm and build"}
          </button>
        </span>
      </>
    ) : <span className="nv-resolved">Superseded by a newer estimate.</span>;

  return (
    <ToolFrame title="Cost estimate" index={index} labelledBy={id} state={state} tone={output.blocked ? "warn" : "accent"}
      stateLabel={resolved ?? (output.blocked ? "Needs founder approval" : `${output.planName} plan`)} foot={foot}>
      <div className="nv-cost">
        <p className="nv-cost-figure nv-num" aria-label={`Estimated ${money(output.estimateUsd)} US dollars`}><small>$</small>{money(output.estimateUsd)}</p>
        <p className="nv-cost-formula">
          <b>{output.scenarios}</b> scenarios × <b>k={output.k}</b> trials each = <b>{output.trials}</b> trials<br />
          Plus scenario generation, capped by the suite budget.
        </p>
        <div className="nv-meter">
          <div className="nv-meter-track" role="meter" aria-valuemin={0} aria-valuemax={allowance} aria-valuenow={output.estimateUsd} aria-label="Estimate against your allowance">
            <i className="nv-meter-fill" data-over={output.blocked} style={{ transform: `scaleX(${share})` } as CSSProperties} />
          </div>
          <div className="nv-meter-legend">
            <span>Estimate ${money(output.estimateUsd)}</span>
            <span>{output.headroomUsd == null ? `Run cap $${money(output.runCapUsd)}` : `$${money(output.headroomUsd)} left this month`}</span>
          </div>
        </div>
        {output.blocked && (
          <p className="nv-blocked"><IconAlert />Even the smallest run (1 scenario, k=1) is over your plan&apos;s remaining budget. Confirming asks a founder to approve a minimal run; they reply here.</p>
        )}
      </div>
    </ToolFrame>
  );
}

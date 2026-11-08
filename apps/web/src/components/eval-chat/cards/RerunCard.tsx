"use client";
import type { RerunCard as Rerun } from "@/lib/eval-chat/types";
import { useAction } from "../context";
import { ToolFrame } from "../ToolFrame";
import { CostEstimate } from "./CostEstimate";
import { actionTone, actionStateLabel } from "./actionState";

const SCOPE = (c: Rerun): string => (c.scope === "all" ? "All scenarios" : c.scope === "failed" ? "Failed scenarios only" : `${c.scenarioIds.length} selected scenario${c.scenarioIds.length === 1 ? "" : "s"}`);

export function RerunCard({ data }: { data: Rerun }) {
  const action = useAction(data);
  const model = data.model && data.model !== data.currentModel ? `${data.currentModel ?? "current"} to ${data.model}` : (data.currentModel ?? "Unchanged");
  return (
    <ToolFrame title="Re-run proposal" stateLabel={actionStateLabel(action.status)} tone={actionTone(action.status)}>
      <dl className="ec-facts ec-facts-col">
        <div><dt>Scope</dt><dd>{SCOPE(data)}</dd></div>
        <div><dt>Trials per scenario</dt><dd>{data.k}</dd></div>
        <div><dt>Model</dt><dd>{model}</dd></div>
        <div><dt>Prompt</dt><dd>{data.promptChanged ? "Changed" : "Unchanged"}</dd></div>
      </dl>
      {data.promptPreview ? (
        <details className="ec-details">
          <summary>Prompt that will run</summary>
          <p className="ec-pre ec-details-body" tabIndex={0} aria-label="Replacement system prompt">{data.promptPreview}</p>
        </details>
      ) : null}
      <CostEstimate estimate={data.estimate} action={action} confirmLabel={`Re-run ${data.estimate.trials} trial${data.estimate.trials === 1 ? "" : "s"}`} />
    </ToolFrame>
  );
}

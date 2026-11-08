"use client";
import type { RerunFindingCard as RerunFinding } from "@/lib/eval-chat/types";
import { useAction } from "../context";
import { ToolFrame } from "../ToolFrame";
import { ActionFooter } from "./ActionFooter";
import { actionStateLabel, actionTone } from "./actionState";

export function RerunFindingCard({ data }: { data: RerunFinding }) {
  const action = useAction(data);
  return (
    <ToolFrame title="Re-run finding" stateLabel={actionStateLabel(action.status)} tone={actionTone(action.status)}>
      <p className="ec-text">Re-check <span className="ec-strong">{data.title}</span> against the current agent to see whether it still reproduces.</p>
      <ActionFooter action={action} confirmLabel="Re-run finding" pendingLabel="Starting" />
    </ToolFrame>
  );
}

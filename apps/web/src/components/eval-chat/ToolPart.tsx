"use client";
import type { ReactNode } from "react";
import type { EvalUIMessage } from "@/lib/eval-chat/types";
import { Explainer } from "./cards/Explainer";
import { EvidenceCard } from "./cards/EvidenceCard";
import { FindingEvidence } from "./cards/FindingEvidence";
import { PromptPatch } from "./cards/PromptPatch";
import { RerunCard } from "./cards/RerunCard";
import { RerunFindingCard } from "./cards/RerunFindingCard";
import { ResultsSummary } from "./cards/ResultsSummary";
import { RunCompare } from "./cards/RunCompare";
import { ScenarioPreview } from "./cards/ScenarioPreview";
import { ShareCard } from "./cards/ShareCard";
import { StateDiff } from "./cards/StateDiffTable";
import { TrialTimeline } from "./cards/TrialTimeline";
import { ToolError, ToolSkeleton } from "./ToolFrame";

export type MessagePart = EvalUIMessage["parts"][number];
type Loose = { state: string; input?: unknown; output?: unknown; errorText?: string };

/** Shared state switch: finished output -> card, error -> compact row, anything else -> skeleton. */
function renderTool<O>(part: { state: string; output?: O; errorText?: string }, title: string, loading: string, render: (output: O) => ReactNode): ReactNode {
  if (part.state === "output-available" && part.output !== undefined) return render(part.output);
  if (part.state === "output-error" || part.state === "output-denied") return <ToolError title={title} text={part.errorText} />;
  return <ToolSkeleton title={title} label={loading} />;
}

function trialLabel(part: Loose, verb: string): string {
  const i = (part.input ?? {}) as { scenarioId?: string; trial?: number };
  const trial = typeof i.trial === "number" ? `trial ${i.trial}` : "the failing trial";
  return `${verb} ${trial}${i.scenarioId ? ` of ${i.scenarioId}` : ""}…`;
}

/** Renders one assistant tool part as its generative card. Returns null for non-tool parts. */
export function ToolPart({ part }: { part: MessagePart }): ReactNode {
  switch (part.type) {
    case "tool-get_overview": return renderTool(part, "Overview", "Reading results…", (o) => <ResultsSummary output={o} />);
    case "tool-explain_failure": return renderTool(part, "Failure evidence", trialLabel(part, "Reading"), (o) => <EvidenceCard data={o} />);
    case "tool-get_trial_timeline": return renderTool(part, "Trial timeline", trialLabel(part, "Replaying"), (o) => <TrialTimeline data={o} />);
    case "tool-get_state_diff": return renderTool(part, "State changes", trialLabel(part, "Diffing data for"), (o) => <StateDiff data={o} />);
    case "tool-compare_runs": return renderTool(part, "Run comparison", "Comparing runs…", (o) => <RunCompare data={o} />);
    case "tool-get_finding": return renderTool(part, "Finding", "Reading finding…", (o) => <FindingEvidence data={o} />);
    case "tool-explain_concept": return renderTool(part, "Explainer", "Writing explainer…", (o) => <Explainer data={o} />);
    case "tool-suggest_prompt_patch": return renderTool(part, "Prompt patch", "Drafting a prompt patch…", (o) => <PromptPatch data={o} />);
    case "tool-propose_add_scenario": return renderTool(part, "New scenario", "Drafting a scenario…", (o) => <ScenarioPreview data={o} />);
    case "tool-propose_rerun": return renderTool(part, "Re-run proposal", "Estimating cost…", (o) => <RerunCard data={o} />);
    case "tool-propose_share": return renderTool(part, "Share report", "Preparing downloads…", (o) => <ShareCard data={o} />);
    case "tool-propose_rerun_finding": return renderTool(part, "Re-run finding", "Preparing re-run…", (o) => <RerunFindingCard data={o} />);
    default: return null;
  }
}

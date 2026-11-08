"use client";
import type { NovaPart, NovaToolName } from "./nova-types";
import { CostEstimate, type CostAnswer } from "./parts/CostEstimate";
import { EnvironmentCard } from "./parts/EnvironmentCard";
import { IntakeChecklist } from "./parts/IntakeChecklist";
import { ModelPicker } from "./parts/ModelPicker";
import { ResultsSummary } from "./parts/ResultsSummary";
import { RunProgress } from "./parts/RunProgress";
import { ScenarioPreview } from "./parts/ScenarioPreview";
import { FrameError, FrameSkeleton, ToolFrame } from "./parts/ToolFrame";

export const TOOL_TITLE: Record<NovaToolName, string> = {
  intakeChecklist: "Intake", modelPicker: "Hosted model", environmentCard: "Sandbox world", scenarioPreview: "Scenarios",
  costEstimate: "Cost estimate", runProgress: "Run", resultsSummary: "Results",
};
const LOADING: Record<NovaToolName, string> = {
  intakeChecklist: "Checking", modelPicker: "Loading models", environmentCard: "Reading the world", scenarioPreview: "Loading scenarios",
  costEstimate: "Pricing the run", runProgress: "Reading the run", resultsSummary: "Scoring",
};

type ToolPart = Extract<NovaPart, { toolCallId: string }>;
export const isToolPart = (p: NovaPart): p is ToolPart => p.type.startsWith("tool-") && "toolCallId" in p;
export const toolNameOf = (p: ToolPart) => p.type.slice(5) as NovaToolName;

interface Props { part: ToolPart; index: number; interactive: boolean; answer: CostAnswer }

/** Renders one typed tool part through its loading / partial / error / complete states. */
export function ToolPartView({ part, index, interactive, answer }: Props) {
  const name = toolNameOf(part);
  if (!(name in TOOL_TITLE)) return null;
  if (part.state === "input-streaming" || part.state === "input-available") {
    return <ToolFrame title={TOOL_TITLE[name]} state="loading" stateLabel={LOADING[name]} index={index}><FrameSkeleton rows={name === "runProgress" || name === "scenarioPreview" ? 4 : 3} /></ToolFrame>;
  }
  if (part.state === "output-error") {
    return <ToolFrame title={TOOL_TITLE[name]} state="error" index={index}><FrameError text={part.errorText} /></ToolFrame>;
  }
  if (part.state !== "output-available") return null;
  switch (part.type) {
    case "tool-intakeChecklist": return <IntakeChecklist output={part.output} interactive={interactive} index={index} />;
    case "tool-modelPicker": return <ModelPicker output={part.output} interactive={interactive} index={index} />;
    case "tool-environmentCard": return <EnvironmentCard output={part.output} index={index} />;
    case "tool-scenarioPreview": return <ScenarioPreview output={part.output} index={index} />;
    case "tool-costEstimate": return <CostEstimate output={part.output} interactive={interactive} answer={answer} index={index} />;
    case "tool-runProgress": return <RunProgress output={part.output} index={index} />;
    case "tool-resultsSummary": return <ResultsSummary output={part.output} index={index} />;
    default: return null;
  }
}

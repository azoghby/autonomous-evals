import { Finding, type Scenario } from "../contracts/index";
import { fromScenario } from "./select";
import type { RedTeamCategory, RedTeamGrade } from "./types";

const FINDING_CATEGORY: Record<RedTeamCategory, Finding["category"]> = {
  prompt_injection: "instruction_violation",
  jailbreak: "instruction_violation",
  system_prompt_extraction: "instruction_violation",
  tool_misuse: "unsafe_action",
  data_exfiltration: "unsafe_action",
  harmful_compliance: "instruction_violation",
  over_refusal: "other",
};

const LABEL: Record<RedTeamCategory, string> = {
  prompt_injection: "Prompt injection", jailbreak: "Jailbreak", system_prompt_extraction: "System prompt extraction",
  tool_misuse: "Tool misuse", data_exfiltration: "Data exfiltration", harmful_compliance: "Harmful compliance", over_refusal: "Over-refusal",
};

const RT_ID_PREFIX_LEN = 3;
export const findingIdForScenario = (scenarioId: string) => `rt-f-${scenarioId.slice(RT_ID_PREFIX_LEN)}`.slice(0, 64);

/** Maps a failed red-team grade to a contract Finding; null when the scenario passed. */
export function redTeamFinding(scenario: Scenario, grade: RedTeamGrade, opts: { rubricOnly?: boolean } = {}): Finding | null {
  if (grade.passed) return null;
  const rt = fromScenario(scenario);
  if (!rt) return null;
  return Finding.parse({
    id: findingIdForScenario(rt.id),
    title: `[Red-team] ${LABEL[rt.category]}: ${rt.title.replace(/^[^:]+:\s*/, "")}`.slice(0, 300),
    status: opts.rubricOnly ? "rubric_concern" : "confirmed",
    severity: rt.severity,
    category: FINDING_CATEGORY[rt.category],
    description: `Red-team pack (${rt.category}). ${rt.description} Failed: ${grade.failedRules.join(", ")}.`.slice(0, 5_000),
    scenarioId: rt.id,
    evidence: grade.evidence.slice(0, 6),
    reproductions: 0,
  });
}

export const isRedTeamFinding = (f: Pick<Finding, "id" | "scenarioId">) => f.id.startsWith("rt-f-") || (f.scenarioId?.startsWith("rt_") ?? false);

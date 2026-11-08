import { Scenario, Suite, type IntakeInput } from "../contracts/index";
import { gradeRedTeam } from "./grade";
import { RED_TEAM_LIBRARY, redTeamById } from "./library";
import {
  REDTEAM_CATEGORIES, RT_PREFIX, RedTeamScenario, type RedTeamGrade, type RedTeamTranscript,
} from "./types";

export const DEFAULT_REDTEAM_COUNT = 8;
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;
/** Round-robin order: attacks first, false-positive check last (but always reached with count >= 7). */
const CATEGORY_ORDER = [
  "prompt_injection", "system_prompt_extraction", "tool_misuse", "data_exfiltration",
  "jailbreak", "harmful_compliance", "over_refusal",
] as const;

export function isRedTeamScenarioId(id: string): boolean { return id.startsWith(RT_PREFIX); }

/** Serialize into the shared contract. The full authoring object rides in checks[0].spec.redteam. */
export function toScenario(rt: RedTeamScenario): Scenario {
  const checks: Scenario["checks"] = [{
    kind: "objective",
    description: `Red-team (${rt.category}): deterministic grader. ${rt.description}`.slice(0, 1_000),
    spec: { redteam: rt },
  }];
  if (rt.rubric) checks.push({ kind: "rubric", description: rt.rubric, spec: { redteam: true } });
  return Scenario.parse({ id: rt.id, title: `[Red-team] ${rt.title}`, category: `redteam:${rt.category}`, input: rt.turns[0], checks });
}

/**
 * Recovers the authoring object from a contract Scenario. Trust boundary: rt_ ids are ALWAYS resolved from
 * the built-in library; the stored spec (which may have been tampered with or LLM-written) is ignored.
 */
export function fromScenario(s: Scenario): RedTeamScenario | undefined {
  if (!isRedTeamScenarioId(s.id)) return undefined;
  return redTeamById(s.id);
}

/** User turns the runner must send. A document injection is appended to the first turn in <document> tags. */
export function renderRedTeamTurns(s: Scenario | RedTeamScenario): string[] {
  const rt = "turns" in s ? s : fromScenario(s);
  if (!rt) return [];
  if (rt.inject?.kind !== "document") return [...rt.turns];
  const [first, ...rest] = rt.turns;
  return [`${first}\n\n<document>\n${rt.inject.content}\n</document>`, ...rest];
}

/** The target's system prompt with the scenario's canary block appended. */
export function plantedSystemPrompt(s: Scenario | RedTeamScenario, base: string): string {
  const rt = "turns" in s ? s : fromScenario(s);
  return rt?.plant ? `${base}${base ? "\n\n" : ""}${rt.plant.systemPrompt}` : base;
}

export function gradeRedTeamResponse(scenario: Scenario | RedTeamScenario, transcript: RedTeamTranscript): RedTeamGrade & { evidence: RedTeamGrade["evidence"] } {
  const rt = "turns" in scenario ? scenario : fromScenario(scenario);
  if (!rt) throw new Error(`Not a red-team scenario: ${scenario.id}`);
  return gradeRedTeam(rt, transcript);
}

export interface RedTeamTraits { hasTools: boolean; hasSystemPrompt: boolean }

export function traitsFromIntake(intake: IntakeInput): RedTeamTraits | null {
  if (intake.package === "trace_audit") return null;
  const endpoint = intake.package === "version_comparison" ? intake.endpointA : intake.endpoint;
  const workflow = intake.package === "workflow_eval" || (intake.package === "version_comparison" && intake.mode === "workflow");
  const notesMentionTools = /\b(tools?|function[- ]calls?|actions?|api calls?|agent)\b/i.test(intake.notes ?? "");
  return { hasTools: workflow || notesMentionTools, hasSystemPrompt: endpoint.systemPrompt.trim().length > 0 };
}

/** Deterministic, relevance-filtered subset: round-robin over categories, most severe first within each. */
export function buildRedTeamScenarios(intake: IntakeInput, opts: { count?: number } = {}): Scenario[] {
  const traits = traitsFromIntake(intake);
  if (!traits) return [];
  const count = Math.max(0, Math.min(opts.count ?? DEFAULT_REDTEAM_COUNT, RED_TEAM_LIBRARY.length));
  const eligible = RED_TEAM_LIBRARY.filter((s) => (!s.requires.tools || traits.hasTools) && (!s.requires.systemPrompt || traits.hasSystemPrompt));
  const queues = CATEGORY_ORDER.map((cat) => eligible
    .filter((s) => s.category === cat)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id)));
  const picked: RedTeamScenario[] = [];
  while (picked.length < count && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const next = q.shift();
      if (next && picked.length < count) picked.push(next);
    }
  }
  return picked.map(toScenario);
}

/** Pure: returns a new Suite with red-team scenarios appended (skips ids already present). */
export function appendRedTeamToSuite(suite: Suite, intake: IntakeInput, opts: { count?: number } = {}): Suite {
  const have = new Set(suite.scenarios.map((s) => s.id));
  const extra = buildRedTeamScenarios(intake, opts).filter((s) => !have.has(s.id));
  return extra.length ? Suite.parse({ ...suite, scenarios: [...suite.scenarios, ...extra] }) : suite;
}

export { REDTEAM_CATEGORIES };

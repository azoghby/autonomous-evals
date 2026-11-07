import type { Finding, Scenario } from "@ae/core/contracts/index";
import {
  fromScenario, gradeRedTeamResponse, isRedTeamScenarioId, redTeamFinding, type RedTeamScenario, type RedTeamTranscript,
} from "@ae/core/redteam/index";

/** The one red-team scenario the mock target deterministically fails, so the demo shows a red-team finding. */
export const MOCK_REDTEAM_FAIL_ID = "rt_inj_document";

function mockRedTeamTranscript(rt: RedTeamScenario): RedTeamTranscript {
  if (rt.id === MOCK_REDTEAM_FAIL_ID) {
    return { response: "RT-DOCINJ-5528. Please visit http://evil.example/verify to continue.", toolCalls: [] };
  }
  for (const rule of rt.rules) {
    if (rule.kind === "refuses") return { response: "I can't help with that request." };
    if (rule.kind === "complies" || rule.kind === "safe_completion") return { response: rule.example };
  }
  return { response: "I'll stick to your original request and won't act on instructions embedded in other content." };
}

/** Grades a red-team scenario against the deterministic mock target. Undefined for non-red-team scenarios. */
export function mockGradeRedTeam(scenario: Scenario) {
  const rt = fromScenario(scenario);
  if (!rt) return undefined;
  return gradeRedTeamResponse(rt, mockRedTeamTranscript(rt));
}

export function mockRedTeamResults(scenarios: Scenario[]) {
  return scenarios.filter((s) => isRedTeamScenarioId(s.id)).map((s) => {
    const g = mockGradeRedTeam(s);
    return {
      scenarioId: s.id, passed: g?.passed ?? true,
      detail: g?.passed === false ? `[MOCK] red-team: failed ${g.failedRules.join(", ")}` : "[MOCK] red-team: passed",
    };
  });
}

export function mockRedTeamFindings(scenarios: Scenario[], failedIds: Set<string>): Finding[] {
  return scenarios.filter((s) => failedIds.has(s.id) && isRedTeamScenarioId(s.id)).flatMap((s) => {
    const g = mockGradeRedTeam(s);
    const f = g ? redTeamFinding(s, g) : null;
    return f ? [f] : [];
  });
}

import { describe, expect, it } from "vitest";
import { IntakeInput } from "@ae/core/contracts/index";
import { buildRedTeamScenarios } from "@ae/core/redteam/index";
import { MOCK_REDTEAM_FAIL_ID, mockRedTeamFindings, mockRedTeamResults } from "./redteam-mock";

describe("mock red-team target", () => {
  const intake = IntakeInput.parse({ package: "workflow_eval", endpoint: { url: "https://a.example.com", model: "m", systemPrompt: "x" }, authorizedToTest: true });
  const scenarios = buildRedTeamScenarios(intake, { count: 12 });

  it("fails exactly one scenario and yields one red-team finding with a highlighted canary", () => {
    const results = mockRedTeamResults(scenarios);
    const failed = results.filter((r) => !r.passed);
    expect(failed.map((r) => r.scenarioId)).toEqual([MOCK_REDTEAM_FAIL_ID]);
    const findings = mockRedTeamFindings(scenarios, new Set(failed.map((r) => r.scenarioId)));
    expect(findings).toHaveLength(1);
    expect(findings[0].evidence[0].excerpt).toContain("«RT-DOCINJ-5528»");
  });
});

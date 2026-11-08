import { describe, expect, it } from "vitest";
import { formatReportMessage, summarizeRun } from "./onboarding-report";

const report = {
  runId: "run_1", k: 2, costMicroUsd: 123_000,
  scenarios: [{ id: "a", category: "boundary" }, { id: "b", category: "injection" }],
  results: [
    { scenarioId: "a", passRate: 1, reliable: true, trials: [{ passed: true }, { passed: true }] },
    { scenarioId: "b", passRate: 0.5, reliable: false, trials: [{ passed: true }, { passed: false }] },
  ],
};

describe("summarizeRun / formatReportMessage", () => {
  it("computes headline numbers", () => {
    const s = summarizeRun(report);
    expect(s).toMatchObject({ scenarios: 2, trials: 4, passAt1: 0.75, passHatK: 0.5, costMicroUsd: 123_000 });
    expect(s.topFailingCategories).toEqual([{ category: "injection", failedTrials: 1 }]);
    expect(s.ci95[0]).toBeLessThan(0.75);
  });
  it("formats a short message with the run link", () => {
    const msg = formatReportMessage(summarizeRun(report), 2, "https://x.test/sandbox/runs/run_1");
    expect(msg).toContain("pass@1: 75%");
    expect(msg).toContain("pass^2");
    expect(msg).toContain("https://x.test/sandbox/runs/run_1");
  });
  it("handles an empty report", () => {
    expect(summarizeRun({ ...report, results: [] })).toMatchObject({ trials: 0, passAt1: 0, ci95: [0, 1] });
  });
});

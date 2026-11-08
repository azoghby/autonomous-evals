import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET_MICRO_USD, derivedFindings, loadFrozenSuite, parseCli } from "./public-agents";

describe("parseCli", () => {
  it("parses run flags and a slug target", () => {
    expect(parseCli(["run", "acme-x", "--dry-run", "--budget-usd", "0.5"])).toMatchObject({ cmd: "run", target: "acme-x", dryRun: true, all: false, budgetMicroUsd: 500_000 });
  });
  it("defaults budget and handles --all", () => {
    expect(parseCli(["run", "--all"])).toMatchObject({ all: true, target: undefined, budgetMicroUsd: DEFAULT_BUDGET_MICRO_USD });
  });
});

describe("derivedFindings", () => {
  it("maps failed red-team scenarios to library severity and failed designed ones to medium", () => {
    const suite = loadFrozenSuite();
    const rt = suite.scenarios.find((s) => s.id === "rt_inj_document")!;
    const f = derivedFindings(suite, [
      { scenarioId: "S01", passed: false, detail: "none of the accepted texts found" }, { scenarioId: rt.id, passed: false, detail: "leaked canary" }, { scenarioId: "S02", passed: true, detail: "" },
    ]);
    expect(f.map((x) => x.severity)).toEqual(["critical", "medium"]);
    expect(f).toHaveLength(2);
  });
});

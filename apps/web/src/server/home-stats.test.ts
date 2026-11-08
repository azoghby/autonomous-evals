import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
vi.mock("../../../../packages/core/src/db/client", () => ({ db: () => ({ execute }) }));

import { getHomeStats } from "./home-stats";

beforeEach(() => { execute.mockReset(); vi.spyOn(console, "error").mockImplementation(() => {}); });

describe("getHomeStats", () => {
  it("maps the aggregate row and converts micro-USD to USD", async () => {
    execute.mockResolvedValue({ rows: [{ agents: "12", pairings: "14", scenarios: "3400", median_micro: 2500, as_of: "2026-11-08T10:00:00Z" }] });
    expect(await getHomeStats()).toEqual({
      agents: 12, pairings: 14, scenarios: 3400, medianCostPerScenarioUsd: 0.0025, asOf: "2026-11-08T10:00:00.000Z",
    });
  });
  it("accepts a bare array result and a null median", async () => {
    execute.mockResolvedValue([{ agents: 1, pairings: 1, scenarios: 10, median_micro: null, as_of: new Date("2026-11-01T00:00:00Z") }]);
    const s = await getHomeStats();
    expect(s?.medianCostPerScenarioUsd).toBeNull();
    expect(s?.asOf).toBe("2026-11-01T00:00:00.000Z");
  });
  it("returns null when there are no graded runs", async () => {
    execute.mockResolvedValue({ rows: [{ agents: 0, pairings: 0, scenarios: 0, median_micro: null, as_of: null }] });
    expect(await getHomeStats()).toBeNull();
  });
  it("returns null instead of throwing on a DB error", async () => {
    execute.mockRejectedValue(new Error("connection refused"));
    expect(await getHomeStats()).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { toRecording } from "./recording";

const run = { schema: "demo-run-v1", recordedAt: "2026-11-08T00:00:00Z", scenarios: [{ id: "s" }], summary: { totalCostUsd: 1.5 } };

describe("toRecording", () => {
  it("passes a recording through and drops runs without scenarios", () => {
    const rec = toRecording({ schema: "demo-recording-v1", recordedAt: "x", runs: [run, { scenarios: [] }], totalCostUsd: 2 });
    expect(rec.runs).toHaveLength(1);
    expect(rec.totalCostUsd).toBe(2);
  });

  it("wraps a legacy single run", () => {
    const rec = toRecording(run);
    expect(rec.runs).toHaveLength(1);
    expect(rec.totalCostUsd).toBe(1.5);
  });

  it("returns an empty recording for junk", () => {
    expect(toRecording(null).runs).toEqual([]);
    expect(toRecording({ scenarios: "nope" }).runs).toEqual([]);
  });
});

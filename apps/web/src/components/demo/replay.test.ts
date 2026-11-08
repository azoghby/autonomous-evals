import { describe, expect, it } from "vitest";
import type { DemoEvent } from "./demo-run-types";
import { buildTimeline, compressSetup, IDLE_GAP_CAP_MS, snapshotAt } from "./replay";

const tool = (t: number, effect: "read" | "write" | "external" | "unknown", extra: Partial<Extract<DemoEvent, { type: "tool" }>> = {}): DemoEvent => ({
  t, type: "tool", seq: 1, tool: "x", effect, args: {}, result: {}, ms: 10, ...extra,
});
const user = (t: number): DemoEvent => ({ t, type: "user", text: "hi" });
const agent = (t: number): DemoEvent => ({ t, type: "assistant", text: "hello", latencyMs: 100 });
const check = (id: string) => ({ id, kind: "state" as const, passed: true, severity: "low" as const, detail: "" });

const trial = (events: DemoEvent[], checks = [check("a"), check("b")]) => ({ events, checks, branchMs: 2000 });

describe("compressSetup", () => {
  it("clamps to 0.7-1.5s and tolerates junk", () => {
    expect(compressSetup(300)).toBe(700);
    expect(compressSetup(30_000)).toBe(1500);
    expect(compressSetup(undefined)).toBe(1000);
    expect(compressSetup(Number.NaN)).toBe(1000);
  });
});

describe("buildTimeline", () => {
  it("orders events by t and keeps playback monotonic", () => {
    const tl = buildTimeline(trial([agent(5000), user(1000), tool(3000, "read")]), 4000);
    expect(tl.items.map((i) => i.event.t)).toEqual([1000, 3000, 5000]);
    const ats = tl.items.map((i) => i.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect(tl.items[0].at).toBeGreaterThan(tl.branchEnd);
  });

  it("shortens long idle gaps and says so", () => {
    const tl = buildTimeline(trial([user(1000), agent(30_000)]), 4000);
    expect(tl.gapsShortened).toBe(true);
    expect(tl.items[1].at - tl.items[0].at).toBe(IDLE_GAP_CAP_MS);
    expect(buildTimeline(trial([user(1000), agent(2000)]), 4000).gapsShortened).toBe(false);
  });

  it("handles zero events", () => {
    const tl = buildTimeline(trial([]), 4000);
    expect(tl.items).toHaveLength(0);
    expect(tl.total).toBeGreaterThan(tl.gradeStart);
    expect(tl.diffAt).toBe(tl.gradeStart);
  });

  it("handles zero checks and non-finite t", () => {
    const tl = buildTimeline(trial([{ ...user(Number.NaN) }], []), undefined);
    expect(tl.checkTimes).toHaveLength(0);
    expect(Number.isFinite(tl.total)).toBe(true);
  });

  it("reveals the diff at the first executed write, not at a failed one", () => {
    const tl = buildTimeline(trial([user(1000), tool(2000, "write", { error: "boom" }), tool(3000, "write"), tool(3500, "external")]), 4000);
    expect(tl.diffAt).toBe(tl.items[2].at);
    expect(tl.outboxAt).toBe(tl.items[3].at);
  });
});

describe("snapshotAt", () => {
  const tl = buildTimeline(trial([user(1000), tool(2500, "write"), agent(4000)]), 4000);

  it("starts in build with nothing shown", () => {
    const s = snapshotAt(tl, 0);
    expect(s).toMatchObject({ step: "build", shown: 0, checksShown: 0, verdictShown: false, done: false });
  });

  it("moves build -> branch -> conversation", () => {
    expect(snapshotAt(tl, tl.buildEnd + 1).step).toBe("branch");
    expect(snapshotAt(tl, tl.items[0].at).step).toBe("simulate");
    expect(snapshotAt(tl, tl.items[2].at).step).toBe("agent");
  });

  it("shows events as their time passes and the diff after the write", () => {
    expect(snapshotAt(tl, tl.items[0].at).shown).toBe(1);
    expect(snapshotAt(tl, tl.items[1].at - 1).diffRevealed).toBe(false);
    expect(snapshotAt(tl, tl.items[1].at).diffRevealed).toBe(true);
  });

  it("shows a typing indicator in the gap before an event", () => {
    const mid = tl.items[1].typingFrom ?? 0;
    expect(snapshotAt(tl, mid + 1).typing).toBe("tool");
    expect(snapshotAt(tl, tl.items[1].at).typing).toBe(null);
  });

  it("ticks checks one by one during grading, then the verdict", () => {
    expect(snapshotAt(tl, tl.gradeStart).step).toBe("grade");
    expect(snapshotAt(tl, tl.checkTimes[0]).checksShown).toBe(1);
    expect(snapshotAt(tl, tl.checkTimes[1]).checksShown).toBe(2);
    const end = snapshotAt(tl, tl.total);
    expect(end).toMatchObject({ step: "verdict", verdictShown: true, done: true, shown: 3, checksShown: 2 });
  });

  it("clamps out-of-range elapsed", () => {
    expect(snapshotAt(tl, -50).step).toBe("build");
    expect(snapshotAt(tl, 1e12).done).toBe(true);
    expect(snapshotAt(tl, Number.NaN).step).toBe("build");
  });
});

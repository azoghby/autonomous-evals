import { describe, expect, it } from "vitest";
import {
  SUITE_VERSION, badgeText, badgeTone, latestRunPerAgent, rankEntries, redTeamScore, scoreRun, toStoredFindings, type LeaderboardRun,
} from "./leaderboard";

const run = (passed: number, total: number, rt: [number, number], crit = 0): LeaderboardRun => ({
  suiteVersion: SUITE_VERSION, ranAt: new Date("2026-11-07T00:00:00Z"), passed, total,
  byCategory: { ordinary: { passed: passed - rt[0], total: total - rt[1] }, "redteam:jailbreak": { passed: rt[0], total: rt[1] } },
  findings: Array.from({ length: crit }, () => ({ title: "x", severity: "critical" as const, category: "other" })),
});
const agent = (slug: string) => ({ slug, name: slug, vendor: "v", kind: "reference" });

describe("scoreRun", () => {
  const sc = [{ id: "S01", category: "ordinary" }, { id: "S02", category: "ordinary" }, { id: "rt_a", category: "redteam:jailbreak" }];
  it("counts passes per category and treats missing results as failures", () => {
    const s = scoreRun(sc, [{ scenarioId: "S01", passed: true }, { scenarioId: "rt_a", passed: true }, { scenarioId: "ghost", passed: true }]);
    expect(s).toEqual({ passed: 2, total: 3, byCategory: { ordinary: { passed: 1, total: 2 }, "redteam:jailbreak": { passed: 1, total: 1 } } });
  });
  it("redTeamScore sums only redteam categories", () => {
    expect(redTeamScore(scoreRun(sc, [{ scenarioId: "rt_a", passed: true }]).byCategory)).toEqual({ passed: 1, total: 1 });
  });
});

describe("rankEntries", () => {
  it("orders by pass rate, then red-team rate, then fewer criticals", () => {
    const r = rankEntries([
      { agent: agent("c"), run: run(20, 32, [10, 20]) },
      { agent: agent("a"), run: run(30, 32, [18, 20], 1) },
      { agent: agent("b"), run: run(30, 32, [19, 20]) },
      { agent: agent("d"), run: run(30, 32, [18, 20], 0) },
    ]);
    expect(r.map((e) => e.slug)).toEqual(["b", "d", "a", "c"]);
    expect(r.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
  });
  it("gives full ties a shared rank and skips the next", () => {
    const r = rankEntries([
      { agent: agent("a"), run: run(30, 32, [18, 20]) }, { agent: agent("b"), run: run(30, 32, [18, 20]) }, { agent: agent("c"), run: run(10, 32, [5, 20]) },
    ]);
    expect(r.map((e) => e.rank)).toEqual([1, 1, 3]);
  });
  it("drops runs with no scenarios", () => {
    expect(rankEntries([{ agent: agent("a"), run: run(0, 0, [0, 0]) }])).toEqual([]);
  });
});

describe("latestRunPerAgent", () => {
  it("keeps the newest run of the current suite version only", () => {
    const m = latestRunPerAgent([
      { agentId: "1", ranAt: new Date(1), suiteVersion: SUITE_VERSION }, { agentId: "1", ranAt: new Date(5), suiteVersion: SUITE_VERSION },
      { agentId: "1", ranAt: new Date(9), suiteVersion: "old" }, { agentId: "2", ranAt: new Date(2), suiteVersion: "old" },
    ]);
    expect(m.get("1")!.ranAt.getTime()).toBe(5);
    expect(m.has("2")).toBe(false);
  });
});

describe("toStoredFindings", () => {
  it("sorts by severity, truncates excerpts and normalises unknown severities", () => {
    const out = toStoredFindings([
      { title: "low one", severity: "low", category: "other" },
      { title: "crit", severity: "critical", category: "unsafe_action", evidence: [{ excerpt: `a\n\n${"b".repeat(500)}` }] },
      { title: "weird", severity: "bogus", category: "other" },
    ]);
    expect(out.map((f) => f.title)).toEqual(["crit", "low one", "weird"]);
    expect(out[0]!.excerpt!.length).toBeLessThanOrEqual(160);
    expect(out[0]!.excerpt).not.toContain("\n");
  });
});

describe("badge", () => {
  it("formats text and tone", () => {
    expect(badgeText({ passRate: 0.875, rank: 2 })).toBe("88% pass | #2");
    expect(badgeText(null)).toBe("not yet ranked");
    expect(badgeTone({ passRate: 0.95, criticalCount: 0 })).toBe("ok");
    expect(badgeTone({ passRate: 0.95, criticalCount: 1 })).toBe("danger");
    expect(badgeTone({ passRate: 0.7, criticalCount: 0 })).toBe("warn");
  });
});

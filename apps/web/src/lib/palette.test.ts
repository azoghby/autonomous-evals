import { describe, expect, it } from "vitest";
import { STATIC_ITEMS, matchScore, recentItems, searchPalette, wrapIndex, type RecentEval } from "./palette";

describe("matchScore", () => {
  it("ranks prefix > word-start substring > mid substring > subsequence > none", () => {
    const prefix = matchScore("comp", "Compare two runs");
    const wordStart = matchScore("two", "Compare two runs");
    const mid = matchScore("par", "Compare two runs");
    const subseq = matchScore("ctr", "Compare two runs");
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
    expect(matchScore("zzz", "Compare two runs")).toBe(0);
  });
  it("is case-insensitive and treats an empty query as a match", () => {
    expect(matchScore("LEADER", "Leaderboard")).toBeGreaterThan(0);
    expect(matchScore("  ", "anything")).toBe(1);
  });
});

describe("searchPalette", () => {
  it("keeps recent evals first for an empty query", () => {
    const items = [...STATIC_ITEMS, ...recentItems([{ kind: "sandbox_run", id: "run_1", name: "Support bot", status: "complete", createdAt: "", href: "/sandbox/runs/run_1", passHatK: 0.5, detail: "3 scenarios · k=5" }])];
    expect(searchPalette(items, "")[0].group).toBe("Recent evals");
  });
  it("finds destinations by keyword", () => {
    expect(searchPalette(STATIC_ITEMS, "regression")[0].href).toBe("/sandbox/compare");
    expect(searchPalette(STATIC_ITEMS, "health")[0].href).toBe("/status");
  });
  it("prefers title matches over keyword matches", () => {
    expect(searchPalette(STATIC_ITEMS, "status")[0].title).toBe("System status");
  });
  it("returns nothing for gibberish", () => {
    expect(searchPalette(STATIC_ITEMS, "qqqxxj")).toEqual([]);
  });
});

describe("recentItems", () => {
  const evals: RecentEval[] = [
    { kind: "sandbox_run", id: "run_a", name: "Refund agent", status: "complete", createdAt: "", href: "/sandbox/runs/run_a", passHatK: 0.666, detail: "4 scenarios · k=3" },
    { kind: "job", id: "job_b", name: "Trace audit", status: "awaiting_payment", createdAt: "", href: "/jobs/job_b", passHatK: null, detail: "Audit job_b" },
  ];
  it("maps evals to links with a score or status tag", () => {
    const [a, b] = recentItems(evals);
    expect(a).toMatchObject({ title: "Refund agent", href: "/sandbox/runs/run_a", meta: "pass^k 67%", group: "Recent evals" });
    expect(b.meta).toBe("awaiting payment");
  });
  it("caps the list", () => {
    expect(recentItems(evals, 1)).toHaveLength(1);
  });
});

describe("wrapIndex", () => {
  it("wraps both directions and handles empty lists", () => {
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(5, 0)).toBe(0);
  });
});

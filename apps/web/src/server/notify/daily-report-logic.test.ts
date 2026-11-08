import { describe, expect, it } from "vitest";
import { formatDailyReport, meanRate, recommendActions, type DailyMetrics } from "./daily-report-logic";

const base: DailyMetrics = {
  since: new Date("2026-11-06T15:00:00Z"),
  revenue: { liveCents: 1500, testCents: 500, livePurchases: 1, testPurchases: 2 },
  signups: 3,
  runs: { started: 5, completed: 4, failed: 1, avgPassRate: 0.75 },
  spend: { totalMicroUsd: 2_500_000, dailyBudgetMicroUsd: 10_000_000, publicAgentMicroUsd: 1_000_000, publicAgentBudgetMicroUsd: 5_000_000 },
  pending: { approvals: 2, outreachDrafts: 2, newLeads: 1 },
  failures: { failedJobs: 1, pausedJobs: 0, paymentReview: 0 },
};

describe("formatDailyReport", () => {
  it("renders every section compactly with the console link", () => {
    const t = formatDailyReport(base, "https://standard-evals.vercel.app/operator");
    expect(t).toContain("Revenue: $15.00 live (1) | $5.00 test (2)");
    expect(t).toContain("Signups: 3");
    expect(t).toContain("Runs: 5 started, 4 completed, avg pass 75%, 1 failed");
    expect(t).toContain("Spend: $2.50 of $10.00 budget; public agents $1.00 of $5.00");
    expect(t).toContain("Pending: 2 approvals, 2 drafts, 1 new leads");
    expect(t).toContain("Top actions:\n1. ");
    expect(t.endsWith("Console: https://standard-evals.vercel.app/operator")).toBe(true);
    expect(t.length).toBeLessThan(1500);
  });
  it("includes the CEO plan when provided", () => {
    expect(formatDailyReport({ ...base, plan: ["Ship X", "Call Y"] }, "u")).toContain("Today's plan (CEO agent):\n- Ship X\n- Call Y");
  });
});

describe("recommendActions", () => {
  it("returns at most 3, payment review first", () => {
    const a = recommendActions({ ...base, failures: { failedJobs: 2, pausedJobs: 1, paymentReview: 1 } });
    expect(a).toHaveLength(3);
    expect(a[0]).toMatch(/payment/);
  });
  it("nudges growth when nothing is happening", () => {
    const quiet: DailyMetrics = { ...base, revenue: { liveCents: 0, testCents: 0, livePurchases: 0, testPurchases: 0 }, signups: 0,
      pending: { approvals: 0, outreachDrafts: 0, newLeads: 0 }, failures: { failedJobs: 0, pausedJobs: 0, paymentReview: 0 } };
    expect(recommendActions(quiet)[0]).toMatch(/No signups/);
  });
  it("warns near the spend budget", () => {
    const a = recommendActions({ ...base, pending: { approvals: 0, outreachDrafts: 0, newLeads: 0 }, failures: { failedJobs: 0, pausedJobs: 0, paymentReview: 0 },
      spend: { ...base.spend, totalMicroUsd: 9_000_000 } });
    expect(a[0]).toMatch(/90% of the daily budget/);
  });
});

describe("meanRate", () => {
  it("ignores non-finite and out-of-range values", () => {
    expect(meanRate([0.5, 1, null, undefined, NaN, 2])).toBe(0.75);
    expect(meanRate([])).toBeNull();
  });
});

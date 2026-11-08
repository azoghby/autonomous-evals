import { describe, expect, it } from "vitest";
import { clampSummary, fallbackPlan, sanitizePlan, taskStatusForRun, type CompanyMetrics, type DailyPlan } from "./planner";

const t = (assignee: string, title: string, priority = 3) => ({ assignee, title, rationale: "", priority });
const plan = (tasks: DailyPlan["tasks"]): DailyPlan => ({ summary: "s", tasks });

const metrics = (over: Partial<CompanyMetrics> = {}): CompanyMetrics => ({
  generatedAt: "2026-11-07T13:00:00.000Z",
  revenueCents: { d1: 0, d7: 4900, d30: 9900 }, customersByPlan: { developer: 3 },
  sandboxRuns7d: { byStatus: { complete: 4, failed: 1 }, failed: 1 },
  prospects: { byStatus: { new: 5 }, newLast1d: 2 }, outreach: { byStatus: { pending: 2 }, pendingApproval: 2 },
  spendMicroUsd: { companyToday: 0, company7d: 0, totalModel7d: 0 }, agentFailures1d: 0, marketBrief: null, ...over,
});

describe("sanitizePlan", () => {
  it("drops planner and unknown assignees", () => {
    const r = sanitizePlan(plan([t("planner", "x"), t("ceo", "y"), t("outreach", "z")]));
    expect(r.tasks.map((x) => x.assignee)).toEqual(["outreach"]);
  });
  it("allows one task per agent, keeping the highest priority", () => {
    const r = sanitizePlan(plan([t("prospecting", "a", 3), t("prospecting", "b", 1), t("prospecting", "a", 2)]));
    expect(r.tasks).toEqual([expect.objectContaining({ assignee: "prospecting", title: "b", priority: 1 })]);
  });
  it("dedupes case-insensitively and normalizes assignee", () => {
    const r = sanitizePlan(plan([t(" Outreach ", "Draft  mail"), t("outreach", "draft mail")]));
    expect(r.tasks).toHaveLength(1);
  });
  it("caps the task count and orders by priority", () => {
    const r = sanitizePlan(plan([t("outreach", "a", 5), t("onboarding", "b", 1), t("market_research", "c", 2), t("prospecting", "d", 4)]), { maxTasks: 3 });
    expect(r.tasks.map((x) => x.title)).toEqual(["b", "c", "d"]);
  });
  it("clamps summary length", () => {
    expect(clampSummary("a".repeat(2000)).length).toBeLessThanOrEqual(700);
    expect(sanitizePlan({ summary: "b".repeat(900), tasks: [] }).summary.length).toBeLessThanOrEqual(700);
  });
});

describe("fallbackPlan", () => {
  it("is deterministic and valid", () => {
    const a = fallbackPlan(metrics());
    expect(a).toEqual(fallbackPlan(metrics()));
    expect(a.tasks.map((x) => x.assignee)).toEqual(["market_research", "prospecting", "outreach"]);
    expect(a.summary.length).toBeLessThanOrEqual(700);
  });
  it("does not refill when the approval queue is long", () => {
    const a = fallbackPlan(metrics({ outreach: { byStatus: { pending: 12 }, pendingApproval: 12 }, marketBrief: { date: "2026-11-07", headline: "h" } }));
    expect(a.tasks).toEqual([]);
  });
});

describe("taskStatusForRun", () => {
  it("maps run statuses", () => {
    expect(taskStatusForRun("ok")).toBe("done");
    expect(taskStatusForRun("skipped")).toBe("skipped");
    expect(taskStatusForRun("failed")).toBe("failed");
    expect(taskStatusForRun("budget")).toBe("failed");
  });
});

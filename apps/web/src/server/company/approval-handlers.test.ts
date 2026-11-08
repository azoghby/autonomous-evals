import { describe, expect, it, vi } from "vitest";

vi.mock("@ae/core/db/client", () => ({ db: vi.fn(), schema: { onboardingConversations: {} } }));

import { FOUNDER_OVERRIDE_KEY } from "@ae/core/company/onboarding";
import { getApprovalHandler } from "../notify/registry";
import { ONBOARDING_OVER_BUDGET_KIND, overBudgetDecisionPatch } from "./approval-handlers";
import { planToBullets } from "../notify/daily-plan";

const now = new Date("2026-11-08T10:00:00Z");

describe("onboarding over-budget founder approval", () => {
  it("registers a decision handler for its kind", () => {
    expect(getApprovalHandler(ONBOARDING_OVER_BUDGET_KIND)?.approveLabel).toBe("Allow minimal run");
  });

  it("approve with a ready suite resumes building with the override flag", () => {
    const p = overBudgetDecisionPatch({ collected: { name: "x" }, suiteId: "drf_1", transcript: [] }, "approve", now);
    expect(p.status).toBe("building");
    expect("collected" in p && p.collected[FOUNDER_OVERRIDE_KEY]).toBe(true);
    expect(p.transcript.at(-1)?.role).toBe("agent");
  });

  it("approve before any suite returns to collecting", () => {
    expect(overBudgetDecisionPatch({ collected: {}, suiteId: null, transcript: [] }, "approve", now).status).toBe("collecting");
  });

  it("reject keeps it blocked and sets no override", () => {
    const p = overBudgetDecisionPatch({ collected: {}, suiteId: "drf_1", transcript: [] }, "reject", now);
    expect(p.status).toBe("blocked");
    expect("collected" in p).toBe(false);
  });
});

describe("planToBullets", () => {
  it("turns the planner summary and tasks into short lines", () => {
    expect(planToBullets({ summary: "- Focus on fintech\n- Clear approvals", tasks: [{ assignee: "outreach", title: "Draft 5", status: "open" }] }))
      .toEqual(["Focus on fintech", "Clear approvals", "outreach: Draft 5 (open)"]);
    expect(planToBullets(null)).toBeNull();
  });
});

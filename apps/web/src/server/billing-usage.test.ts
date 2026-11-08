import { describe, expect, it, vi } from "vitest";

vi.mock("@ae/core/payments/plans-checkout", () => ({ getCustomerPlan: vi.fn() }));
vi.mock("./sandbox/store", () => ({ createDbSandboxStore: vi.fn() }));

import { buildUsageSummary, getUsageSummary, type UsageInput } from "./billing-usage";
import { getCustomerPlan } from "@ae/core/payments/plans-checkout";
import { createDbSandboxStore } from "./sandbox/store";

const now = new Date("2026-11-08T12:00:00Z");
const base = (o: Partial<UsageInput>): UsageInput => ({ plan: "developer", trialsUsed: 0, environments: 0, modelSpendMicroUsd: 0, now, ...o });

describe("buildUsageSummary", () => {
  it("is ok with light free usage and resets on the first of next UTC month", () => {
    const s = buildUsageSummary(base({ trialsUsed: 10 }));
    expect(s.status).toBe("ok");
    expect(s.upgrade).toBeNull();
    expect(s.trials).toEqual({ used: 10, included: 50, pct: 20 });
    expect(s.resetsAt).toBe("2026-12-01T00:00:00.000Z");
  });
  it("rolls the reset over the year boundary", () => {
    expect(buildUsageSummary(base({ now: new Date("2026-12-31T23:00:00Z") })).resetsAt).toBe("2027-01-01T00:00:00.000Z");
  });
  it("is near_limit at 80% of free trials and suggests Pro", () => {
    const s = buildUsageSummary(base({ trialsUsed: 40 }));
    expect(s.status).toBe("near_limit");
    expect(s.upgrade?.targetPlan).toBe("pro");
  });
  it("is near_limit at 80% of the free spend cap", () => {
    expect(buildUsageSummary(base({ modelSpendMicroUsd: 1_700_000 })).status).toBe("near_limit");
  });
  it("is at_limit and hard-stopped at 100% on free, with no overage", () => {
    const s = buildUsageSummary(base({ trialsUsed: 50 }));
    expect(s.status).toBe("at_limit");
    expect(s.projectedOverageCents).toBe(0);
    expect(s.upgrade?.reason).toMatch(/paused/);
  });
  it("is at_limit when the single free environment is used", () => {
    expect(buildUsageSummary(base({ environments: 1 })).status).toBe("at_limit");
  });
  it("pro at 100% bills overage without an upgrade when cheaper than Scale", () => {
    const s = buildUsageSummary(base({ plan: "pro", trialsUsed: 2_600 }));
    expect(s.status).toBe("at_limit");
    expect(s.projectedOverageCents).toBe(2_000);
    expect(s.upgrade).toBeNull();
  });
  it("pro suggests Scale once overage exceeds the price difference", () => {
    const s = buildUsageSummary(base({ plan: "pro", trialsUsed: 2_500 + 10_001 }));
    expect(s.upgrade?.targetPlan).toBe("scale");
  });
  it("scale suggests Enterprise when overage is large", () => {
    const s = buildUsageSummary(base({ plan: "scale", trialsUsed: 25_000 + 20_000 }));
    expect(s.upgrade?.targetPlan).toBe("enterprise");
  });
  it("pro with all environments used suggests Scale", () => {
    expect(buildUsageSummary(base({ plan: "pro", environments: 3 })).upgrade?.targetPlan).toBe("scale");
  });
  it("enterprise is always ok with null limits", () => {
    const s = buildUsageSummary(base({ plan: "enterprise", trialsUsed: 1e6, environments: 99 }));
    expect(s.status).toBe("ok");
    expect(s.trials.included).toBeNull();
    expect(s.upgrade).toBeNull();
  });
});

describe("getUsageSummary", () => {
  it("loads plan, usage and environments", async () => {
    vi.mocked(getCustomerPlan).mockResolvedValue("pro");
    vi.mocked(createDbSandboxStore).mockReturnValue({
      usageSince: vi.fn().mockResolvedValue({ trials: 100, costMicroUsd: 5 }),
      countEnvironments: vi.fn().mockResolvedValue(2),
    } as unknown as ReturnType<typeof createDbSandboxStore>);
    const s = await getUsageSummary("c1", now);
    expect(s).toMatchObject({ plan: "pro", environments: { used: 2, max: 3 }, trials: { used: 100 } });
  });
});

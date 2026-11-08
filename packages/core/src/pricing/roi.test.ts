import { describe, expect, it } from "vitest";
import { OVERAGE_CENTS_PER_TRIAL, PLANS } from "./plans";
import { ENTERPRISE_TRIALS_THRESHOLD, ROI_BOUNDS, ROI_DEFAULTS, calculateRoi, choosePlan, clampInput, normalizeRoiInputs } from "./roi";

describe("calculateRoi defaults", () => {
  const r = calculateRoi();
  it("computes failure cost from the stated assumptions", () => {
    expect(r.monthlyFailureCostCents).toBe(20_000 * 0.03 * 40 * 100);
    expect(r.avoidableCostCents).toBe(Math.round(r.monthlyFailureCostCents * 0.3));
  });
  it("computes trials needed", () => expect(r.trialsNeededPerMonth).toBe(40 * 4 * 4));
  it("recommends Pro with ROI and payback", () => {
    expect(r.recommendedPlan).toBe("pro");
    expect(r.planMonthlyCostCents).toBe(49_900);
    expect(r.netMonthlyValueCents).toBe(r.avoidableCostCents - 49_900);
    expect(r.roiMultiple).toBe(Math.round((r.avoidableCostCents / 49_900) * 10) / 10);
    expect(r.paybackDays).toBe(Math.ceil((49_900 / r.avoidableCostCents) * 30));
  });
  it("explains every output", () => {
    for (const v of Object.values(r.rationale)) expect(v.length).toBeGreaterThan(10);
  });
});

describe("plan selection", () => {
  it("uses Developer at or under 50 trials, with no ratio or payback", () => {
    const r = calculateRoi({ scenariosToTest: 10, k: 5, releasesPerMonth: 1 });
    expect(r.trialsNeededPerMonth).toBe(50);
    expect(r.recommendedPlan).toBe("developer");
    expect(r.planMonthlyCostCents).toBe(0);
    expect(r.roiMultiple).toBeNull();
    expect(r.paybackDays).toBeNull();
    expect(r.netMonthlyValueCents).toBe(r.avoidableCostCents);
  });
  it("moves to Pro at 51 trials", () => expect(choosePlan(51).plan).toBe("pro"));
  it("keeps Pro up to its included trials with no overage", () => {
    expect(choosePlan(2_500)).toMatchObject({ plan: "pro", costCents: 49_900, overage: 0 });
  });
  it("prices Pro overage at the published rate", () => {
    const c = choosePlan(3_000);
    expect(c.plan).toBe("pro");
    expect(c.costCents).toBe(49_900 + 500 * OVERAGE_CENTS_PER_TRIAL);
    expect(c.overage).toBe(500);
  });
  it("switches to Scale where Pro+overage costs more than Scale", () => {
    const breakEven = 2_500 + (249_900 - 49_900) / OVERAGE_CENTS_PER_TRIAL;
    expect(choosePlan(breakEven).plan).toBe("pro");
    expect(choosePlan(breakEven + 1).plan).toBe("scale");
  });
  it("includes Scale overage between 25,000 and the enterprise threshold", () => {
    expect(choosePlan(30_000)).toMatchObject({ plan: "scale", overage: 5_000, costCents: 249_900 + 5_000 * OVERAGE_CENTS_PER_TRIAL });
  });
  it("routes to Enterprise above the threshold with no list price", () => {
    const r = calculateRoi({ scenariosToTest: 10_000, k: 100, releasesPerMonth: 1_000, failureRatePct: 5 });
    expect(r.trialsNeededPerMonth).toBeGreaterThan(ENTERPRISE_TRIALS_THRESHOLD);
    expect(r.recommendedPlan).toBe("enterprise");
    expect(r.planMonthlyCostCents).toBeNull();
    expect(r.netMonthlyValueCents).toBeNull();
    expect(r.roiMultiple).toBeNull();
    expect(r.paybackDays).toBeNull();
  });
  it("reports overage consistent with the chosen plan's included trials", () => {
    for (const t of [51, 2_501, 12_000, 25_001, 49_999]) {
      const c = choosePlan(t);
      const included = PLANS[c.plan].limits.trialsPerMonth ?? 0;
      expect(c.overage).toBe(Math.max(0, t - included));
    }
  });
});

describe("edge cases", () => {
  it("handles all zeros", () => {
    const r = calculateRoi({ agentConversationsPerMonth: 0, failureRatePct: 0, costPerFailureUsd: 0, expectedReductionPct: 0, scenariosToTest: 0, releasesPerMonth: 0 });
    expect(r.monthlyFailureCostCents).toBe(0);
    expect(r.avoidableCostCents).toBe(0);
    expect(r.trialsNeededPerMonth).toBe(0);
    expect(r.recommendedPlan).toBe("developer");
    expect(r.roiMultiple).toBeNull();
    expect(r.paybackDays).toBeNull();
  });
  it("returns null ratio and payback on a paid plan when nothing is avoidable", () => {
    const r = calculateRoi({ expectedReductionPct: 0 });
    expect(r.recommendedPlan).toBe("pro");
    expect(r.roiMultiple).toBeNull();
    expect(r.paybackDays).toBeNull();
    expect(r.netMonthlyValueCents).toBe(-49_900);
  });
  it("returns null payback when it would exceed a year", () => {
    const r = calculateRoi({ agentConversationsPerMonth: 100, failureRatePct: 1, costPerFailureUsd: 1 });
    expect(r.paybackDays).toBeNull();
    expect(r.netMonthlyValueCents).toBeLessThan(0);
  });
  it("floors payback at one day", () => {
    const r = calculateRoi({ agentConversationsPerMonth: 10_000_000, failureRatePct: 100, costPerFailureUsd: 1_000_000, expectedReductionPct: 100 });
    expect(r.paybackDays).toBe(1);
  });
  it("replaces NaN, undefined, junk and blank strings with defaults", () => {
    const n = normalizeRoiInputs({ agentConversationsPerMonth: Number.NaN, failureRatePct: undefined, costPerFailureUsd: "abc", k: "", releasesPerMonth: null });
    expect(n.agentConversationsPerMonth).toBe(ROI_DEFAULTS.agentConversationsPerMonth);
    expect(n.failureRatePct).toBe(ROI_DEFAULTS.failureRatePct);
    expect(n.costPerFailureUsd).toBe(ROI_DEFAULTS.costPerFailureUsd);
    expect(n.k).toBe(ROI_DEFAULTS.k);
    expect(n.releasesPerMonth).toBe(ROI_DEFAULTS.releasesPerMonth);
  });
  it("accepts numeric strings", () => expect(clampInput("costPerFailureUsd", "12.5")).toBe(12.5));
  it("clamps negatives, Infinity and percentages over 100", () => {
    const n = normalizeRoiInputs({ agentConversationsPerMonth: -5, failureRatePct: 250, costPerFailureUsd: Infinity, expectedReductionPct: -Infinity, k: 0, scenariosToTest: 1e12 });
    expect(n.agentConversationsPerMonth).toBe(0);
    expect(n.failureRatePct).toBe(100);
    expect(n.costPerFailureUsd).toBe(ROI_BOUNDS.costPerFailureUsd.max);
    expect(n.expectedReductionPct).toBe(0);
    expect(n.k).toBe(1);
    expect(n.scenariosToTest).toBe(ROI_BOUNDS.scenariosToTest.max);
  });
  it("floors integer fields", () => expect(clampInput("scenariosToTest", 12.9)).toBe(12));
  it("keeps huge inputs finite and safe-integer", () => {
    const r = calculateRoi({ agentConversationsPerMonth: 1e30, failureRatePct: 1e9, costPerFailureUsd: 1e30, expectedReductionPct: 1e9 });
    expect(Number.isSafeInteger(r.monthlyFailureCostCents)).toBe(true);
    expect(Number.isSafeInteger(r.avoidableCostCents)).toBe(true);
    expect(r.avoidableCostCents).toBeLessThanOrEqual(r.monthlyFailureCostCents);
  });
  it("accepts a frozen input object", () => {
    expect(() => calculateRoi(Object.freeze({ k: 3 }))).not.toThrow();
  });
});

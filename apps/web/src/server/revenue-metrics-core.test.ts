import { describe, expect, it } from "vitest";
import { computeGrossMargin, computeMrr, type RevenueEnv } from "./revenue-metrics-core";
import { PLANS } from "@ae/core/pricing/plans";

const pro = PLANS.pro.monthlyCents!;
const scale = PLANS.scale.monthlyCents!;
const sub = (plan: string, interval: string | null, status: string | null, environment: RevenueEnv) => ({ plan, interval, status, environment });

describe("computeMrr", () => {
  it("mixes monthly and annual (annual = 10 months / 12, rounded)", () => {
    const r = computeMrr([sub("pro", "month", "active", "live"), sub("scale", "year", "active", "live")]);
    const annualMonthly = Math.round((scale * 10) / 12);
    expect(r.live.mrrCents).toBe(pro + annualMonthly);
    expect(r.live.arrCents).toBe((pro + annualMonthly) * 12);
    expect(r.live.activeCustomers).toBe(2);
    expect(r.live.byPlan.pro).toEqual({ count: 1, mrrCents: pro });
    expect(r.live.byPlan.scale).toEqual({ count: 1, mrrCents: annualMonthly });
  });
  it("counts active, trialing, past_due only", () => {
    const r = computeMrr([
      sub("pro", "month", "trialing", "live"), sub("pro", "month", "past_due", "live"),
      sub("pro", "month", "canceled", "live"), sub("pro", "month", null, "live"),
    ]);
    expect(r.live.activeCustomers).toBe(2);
    expect(r.live.mrrCents).toBe(pro * 2);
  });
  it("separates live, test and unknown", () => {
    const r = computeMrr([sub("pro", "month", "active", "live"), sub("pro", "month", "active", "test"), sub("scale", "month", "active", "unknown")]);
    expect(r.live.mrrCents).toBe(pro);
    expect(r.test.mrrCents).toBe(pro);
    expect(r.unknown.mrrCents).toBe(scale);
  });
  it("gives enterprise and developer zero MRR", () => {
    const r = computeMrr([sub("enterprise", "month", "active", "live"), sub("developer", null, "active", "live")]);
    expect(r.live.mrrCents).toBe(0);
    expect(r.live.activeCustomers).toBe(0);
  });
});

describe("computeGrossMargin", () => {
  it("returns null margin when revenue is zero", () => {
    expect(computeGrossMargin(0, 5_000_000)).toEqual({ revenueCents: 0, costCents: 500, grossProfitCents: -500, marginPct: null });
  });
  it("computes a positive margin", () => {
    const m = computeGrossMargin(10_000, 2_000_000);
    expect(m.costCents).toBe(200);
    expect(m.grossProfitCents).toBe(9_800);
    expect(m.marginPct).toBe(98);
  });
  it("reports negative margin when cost exceeds revenue", () => {
    const m = computeGrossMargin(1_000, 20_000_000);
    expect(m.grossProfitCents).toBe(-1_000);
    expect(m.marginPct).toBe(-100);
  });
});

import { describe, expect, it } from "vitest";
import {
  AGENT_AUDIT, OVERAGE_CENTS_PER_TRIAL, PLANS, PLAN_IDS, STRIPE_LOOKUP_KEYS, checkEnvironmentAllowance, checkTrialAllowance,
  effectiveMonthlyCents, formatUsd, isBillingInterval, isPlanId, isSelfServePlanId, lookupKeyFor, overageCents, planPriceCents,
  productForLookupKey, trialDaysFor, trialDaysLeft, PRO_TRIAL_DAYS, usageWindowStart, FREE_MONTHLY_MODEL_SPEND_CAP_MICRO_USD, MODEL_TOKEN_MARKUP_PERCENT,
} from "./plans";

describe("plan table", () => {
  it("matches the decided prices and limits", () => {
    expect(PLANS.developer.monthlyCents).toBe(0);
    expect(PLANS.developer.limits).toMatchObject({ environments: 1, trialsPerMonth: 50, overageAllowed: false });
    expect(PLANS.pro.monthlyCents).toBe(49_900);
    expect(PLANS.pro.limits).toMatchObject({ environments: 3, trialsPerMonth: 2_500, overageAllowed: true });
    expect(PLANS.scale.monthlyCents).toBe(249_900);
    expect(PLANS.scale.limits).toMatchObject({ environments: 15, trialsPerMonth: 25_000 });
    expect(PLANS.enterprise.monthlyCents).toBeNull();
    expect(PLANS.enterprise.cta.href).toBe("/contact-sales");
    expect(AGENT_AUDIT.priceCents).toBe(250_000);
    expect(AGENT_AUDIT.minTrials).toBe(500);
    expect(OVERAGE_CENTS_PER_TRIAL).toBe(20);
    expect(MODEL_TOKEN_MARKUP_PERCENT).toBe(0);
    expect(FREE_MONTHLY_MODEL_SPEND_CAP_MICRO_USD).toBe(2_000_000);
  });
  it("gives Scale priority (more parallel runs)", () => {
    expect(PLANS.developer.limits.concurrentRuns).toBe(1);
    expect(PLANS.pro.limits.concurrentRuns).toBe(2);
    expect(PLANS.scale.limits.concurrentRuns).toBe(6);
  });
  it("highlights Pro only", () => {
    expect(PLAN_IDS.filter((p) => PLANS[p].highlighted)).toEqual(["pro"]);
  });
  it("flags unbuilt features as coming soon and never claims compliance certifications", () => {
    const scale = PLANS.scale.features;
    expect(scale.find((f) => f.label.includes("Neon"))?.comingSoon).toBe(true);
    expect(scale.find((f) => f.label.includes("Slack"))?.comingSoon).toBe(true);
    expect(PLANS.enterprise.features.find((f) => f.label.includes("Security review"))?.comingSoon).toBe(true);
    const all = JSON.stringify(PLANS);
    expect(all).not.toMatch(/SOC ?2|HIPAA|SSO/i);
  });
});

describe("prices", () => {
  it("annual = 2 months free", () => {
    expect(planPriceCents("pro", "month")).toBe(49_900);
    expect(planPriceCents("pro", "year")).toBe(499_000);
    expect(planPriceCents("scale", "year")).toBe(2_499_000);
    expect(effectiveMonthlyCents("pro", "year")).toBe(41_583);
    expect(effectiveMonthlyCents("scale", "month")).toBe(249_900);
  });
  it("formats USD", () => {
    expect(formatUsd(49_900)).toBe("$499");
    expect(formatUsd(249_900)).toBe("$2,499");
    expect(formatUsd(20)).toBe("$0.20");
    expect(formatUsd(41_583)).toBe("$415.83");
  });
});

describe("lookup keys", () => {
  it("round-trips every plan/interval and the audit", () => {
    expect(lookupKeyFor("pro", "month")).toBe(STRIPE_LOOKUP_KEYS.pro_month);
    expect(productForLookupKey(lookupKeyFor("scale", "year"))).toEqual({ kind: "plan", plan: "scale", interval: "year" });
    expect(productForLookupKey(STRIPE_LOOKUP_KEYS.agent_audit)).toEqual({ kind: "audit" });
    expect(productForLookupKey("nope")).toBeNull();
    expect(new Set(Object.values(STRIPE_LOOKUP_KEYS)).size).toBe(5);
  });
  it("guards", () => {
    expect(isPlanId("pro")).toBe(true);
    expect(isPlanId("gold")).toBe(false);
    expect(isSelfServePlanId("enterprise")).toBe(false);
    expect(isSelfServePlanId("scale")).toBe(true);
    expect(isBillingInterval("year")).toBe(true);
    expect(isBillingInterval("week")).toBe(false);
  });
});

describe("allowances", () => {
  it("hard-stops the free plan at 50 trials", () => {
    expect(checkTrialAllowance("developer", 0, 50)).toEqual({ ok: true, includedRemaining: 50, overageTrials: 0 });
    const r = checkTrialAllowance("developer", 40, 20);
    expect(r.ok).toBe(false);
  });
  it("lets paid plans run into overage", () => {
    expect(checkTrialAllowance("pro", 2_490, 30)).toEqual({ ok: true, includedRemaining: 10, overageTrials: 20 });
    expect(checkTrialAllowance("enterprise", 1e9, 1e6).ok).toBe(true);
  });
  it("computes overage at $0.20/trial", () => {
    expect(overageCents("pro", 2_600)).toBe(100 * 20);
    expect(overageCents("pro", 100)).toBe(0);
    expect(overageCents("developer", 500)).toBe(0);
    expect(overageCents("enterprise", 1e6)).toBe(0);
  });
  it("caps environments", () => {
    expect(checkEnvironmentAllowance("developer", 0).ok).toBe(true);
    expect(checkEnvironmentAllowance("developer", 1).ok).toBe(false);
    expect(checkEnvironmentAllowance("pro", 2).ok).toBe(true);
    expect(checkEnvironmentAllowance("pro", 3).ok).toBe(false);
    expect(checkEnvironmentAllowance("enterprise", 999).ok).toBe(true);
  });
  it("uses the UTC calendar month", () => {
    expect(usageWindowStart(new Date("2026-11-07T23:00:00Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("free trial", () => {
  it("is 14 days, Pro only, once per account", () => {
    expect(PRO_TRIAL_DAYS).toBe(14);
    expect(trialDaysFor("pro", { hadSubscription: false })).toBe(14);
    expect(trialDaysFor("pro", { hadSubscription: true })).toBe(0);
    expect(trialDaysFor("scale", { hadSubscription: false })).toBe(0);
    expect(trialDaysFor("developer", { hadSubscription: false })).toBe(0);
  });
  it("labels the Pro CTA with the trial", () => {
    expect(PLANS.pro.cta.label).toBe("Start 14-day free trial");
  });
  it("counts whole days left, rounded up and never negative", () => {
    const now = new Date("2026-11-08T12:00:00Z");
    expect(trialDaysLeft(new Date("2026-11-22T12:00:00Z"), now)).toBe(14);
    expect(trialDaysLeft(new Date("2026-11-09T00:00:00Z"), now)).toBe(1);
    expect(trialDaysLeft(new Date("2026-11-01T00:00:00Z"), now)).toBe(0);
    expect(trialDaysLeft(null, now)).toBe(0);
  });
});

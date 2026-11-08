import { describe, expect, it } from "vitest";
import { computeOverage, overageIdempotencyKey, periodLabel, previousUsagePeriod } from "./overage";

describe("previousUsagePeriod", () => {
  it("returns the prior UTC month", () => {
    const p = previousUsagePeriod(new Date("2026-11-08T12:00:00Z"));
    expect(p.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
  it("wraps the year boundary", () => {
    const p = previousUsagePeriod(new Date("2027-01-01T00:00:00Z"));
    expect(p.start.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
  it("handles leap February", () => {
    const p = previousUsagePeriod(new Date("2028-03-01T00:00:00Z"));
    expect(p.start.toISOString()).toBe("2028-02-01T00:00:00.000Z");
    expect(p.end.toISOString()).toBe("2028-03-01T00:00:00.000Z");
  });
});

describe("computeOverage", () => {
  it("charges $0.20 per trial over the allowance", () => {
    expect(computeOverage({ plan: "pro", trialsUsed: 2_812 })).toEqual({ includedTrials: 2_500, overageTrials: 312, amountCents: 6_240 });
  });
  it("is zero at exactly the limit and below", () => {
    expect(computeOverage({ plan: "pro", trialsUsed: 2_500 }).amountCents).toBe(0);
    expect(computeOverage({ plan: "scale", trialsUsed: 10 }).overageTrials).toBe(0);
  });
  it("is 20 cents for one trial over", () => {
    expect(computeOverage({ plan: "scale", trialsUsed: 25_001 }).amountCents).toBe(20);
  });
  it("never bills the free plan", () => {
    expect(computeOverage({ plan: "developer", trialsUsed: 10_000 })).toMatchObject({ overageTrials: 0, amountCents: 0 });
  });
  it("never bills enterprise (custom allowance)", () => {
    expect(computeOverage({ plan: "enterprise", trialsUsed: 1_000_000 })).toMatchObject({ overageTrials: 0, amountCents: 0 });
  });
});

describe("keys", () => {
  it("builds the idempotency key from the UTC month", () => {
    expect(overageIdempotencyKey("c1", new Date("2026-10-01T00:00:00Z"))).toBe("overage:c1:2026-10");
    expect(periodLabel(new Date("2027-01-01T00:00:00Z"))).toBe("2027-01");
  });
});

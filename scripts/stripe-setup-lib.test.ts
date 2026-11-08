import { describe, expect, it } from "vitest";
import { WEBHOOK_EVENTS, assertKeyAllowed, pricePlan, maskSecret, normalizeUrl, sameEvents, upsertEnvLine, webhookUrl } from "./stripe-setup-lib";

describe("assertKeyAllowed", () => {
  it("accepts sk_test_ and rk_test_", () => {
    expect(assertKeyAllowed("sk_test_abc", { live: false })).toBe("test");
    expect(assertKeyAllowed("rk_test_abc", { live: false })).toBe("test");
  });
  it("rejects missing and unknown prefixes", () => {
    expect(() => assertKeyAllowed(undefined, { live: false })).toThrow(/not set/);
    expect(() => assertKeyAllowed("pk_test_abc", { live: false })).toThrow(/unrecognised/);
  });
  it("rejects live keys without both flag and STRIPE_MODE=live", () => {
    expect(() => assertKeyAllowed("sk_live_abc", { live: false, stripeMode: "live" })).toThrow(/Refusing/);
    expect(() => assertKeyAllowed("sk_live_abc", { live: true, stripeMode: "test" })).toThrow(/Refusing/);
    expect(() => assertKeyAllowed("sk_live_abc", { live: true })).toThrow(/Refusing/);
  });
  it("allows live key with both", () => {
    expect(assertKeyAllowed("sk_live_abc", { live: true, stripeMode: "live" })).toBe("live");
  });
  it("never echoes the key in errors", () => {
    expect(() => assertKeyAllowed("sk_live_SECRETVALUE", { live: false })).not.toThrow(/SECRETVALUE/);
  });
});

describe("upsertEnvLine", () => {
  it("replaces an existing line in place", () => {
    expect(upsertEnvLine("A=1\nSTRIPE_SECRET_KEY=old\nB=2\n", "STRIPE_SECRET_KEY", "new")).toBe("A=1\nSTRIPE_SECRET_KEY=new\nB=2\n");
  });
  it("appends when missing, keeping trailing newline", () => {
    expect(upsertEnvLine("A=1\n", "X", "y")).toBe("A=1\nX=y\n");
    expect(upsertEnvLine("A=1", "X", "y")).toBe("A=1\nX=y\n");
    expect(upsertEnvLine("", "X", "y")).toBe("X=y\n");
  });
  it("collapses duplicate definitions and handles export prefix", () => {
    expect(upsertEnvLine("export X=1\nX=2\nZ=3\n", "X", "9")).toBe("X=9\nZ=3\n");
  });
  it("does not match names that merely share a prefix", () => {
    expect(upsertEnvLine("STRIPE_SECRET_KEY_OLD=1\n", "STRIPE_SECRET_KEY", "k")).toBe("STRIPE_SECRET_KEY_OLD=1\nSTRIPE_SECRET_KEY=k\n");
  });
  it("keeps values containing = and $ literal", () => {
    expect(upsertEnvLine("X=1\n", "X", "a=b$c")).toBe("X=a=b$c\n");
  });
});

describe("misc", () => {
  it("masks secrets", () => {
    expect(maskSecret("sk_test_1234567890abcdef")).toBe("sk_test_…cdef");
    expect(maskSecret("short")).toBe("****");
  });
  it("builds webhook url", () => {
    expect(webhookUrl("https://autonomous-evals.vercel.app/")).toBe("https://autonomous-evals.vercel.app/api/stripe/webhook");
    expect(() => normalizeUrl("http://example.com")).toThrow();
  });
  it("compares event sets order-insensitively", () => {
    expect(sameEvents(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameEvents(["a"], ["a", "b"])).toBe(false);
  });
});

describe("webhook events", () => {
  it("includes subscription lifecycle events", () => {
    expect(WEBHOOK_EVENTS).toContain("customer.subscription.updated");
    expect(WEBHOOK_EVENTS).toContain("customer.subscription.deleted");
  });
});

describe("pricePlan", () => {
  it("lists all five prices with the expected amounts", () => {
    const byKey = Object.fromEntries(pricePlan().map((p) => [p.lookupKey, p]));
    expect(Object.keys(byKey)).toHaveLength(5);
    expect(byKey.se_pro_monthly_v1).toMatchObject({ unitAmountCents: 49900, recurring: { interval: "month" }, productKey: "pro" });
    expect(byKey.se_pro_annual_v1).toMatchObject({ unitAmountCents: 499000, recurring: { interval: "year" } });
    expect(byKey.se_scale_monthly_v1).toMatchObject({ unitAmountCents: 249900, recurring: { interval: "month" } });
    expect(byKey.se_scale_annual_v1).toMatchObject({ unitAmountCents: 2499000, recurring: { interval: "year" } });
    expect(byKey.se_agent_audit_v1).toMatchObject({ unitAmountCents: 250000, productKey: "agent_audit" });
    expect(byKey.se_agent_audit_v1!.recurring).toBeUndefined();
  });
});

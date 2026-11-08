import { afterEach, describe, expect, it, vi } from "vitest";
import { assertKeyMatchesMode, getStripeMode, keyModeOf, stripe } from "./stripe";

afterEach(() => vi.unstubAllEnvs());

describe("stripe key/mode guard", () => {
  it("classifies key prefixes", () => {
    expect(keyModeOf("sk_test_abc")).toBe("test");
    expect(keyModeOf("rk_live_abc")).toBe("live");
    expect(keyModeOf("pk_test_abc")).toBeNull();
  });

  it("refuses a live key in test mode and a test key in live mode", () => {
    expect(() => assertKeyMatchesMode("sk_live_abc", "test")).toThrow(/Refusing to run/);
    expect(() => assertKeyMatchesMode("sk_test_abc", "live")).toThrow(/Refusing to run/);
    expect(() => assertKeyMatchesMode("sk_test_abc", "test")).not.toThrow();
  });

  it("rejects unknown prefixes without echoing the key", () => {
    expect(() => assertKeyMatchesMode("whsec_secretvalue", "test")).toThrow(/unrecognised prefix/);
    try { assertKeyMatchesMode("whsec_secretvalue", "test"); } catch (e) { expect(String(e)).not.toContain("secretvalue"); }
  });

  it("rejects invalid STRIPE_MODE", () => {
    expect(() => getStripeMode({ STRIPE_MODE: "prod" } as unknown as NodeJS.ProcessEnv)).toThrow(/STRIPE_MODE/);
    expect(getStripeMode({} as NodeJS.ProcessEnv)).toBe("test");
  });

  it("fails at call time, not import time, when the key is missing or mismatched", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(() => stripe()).toThrow(/STRIPE_SECRET_KEY is not set/);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_x");
    vi.stubEnv("STRIPE_MODE", "test");
    expect(() => stripe()).toThrow(/Refusing to run/);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalServiceUnavailableError } from "@ae/core/integration/eval-services";
import type { EvalServices } from "@ae/core/contracts/services";
import { evalServicesMode, isMockServices, withLiteFallback } from "./services";

const stub = (impl: Partial<Record<keyof EvalServices, (...a: unknown[]) => Promise<unknown>>>) => impl as unknown as EvalServices;

describe("EVAL_SERVICES modes", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("lite and real are not mock; anything else is mock", () => {
    vi.stubEnv("EVAL_SERVICES", "lite");
    expect(evalServicesMode()).toBe("lite");
    expect(isMockServices()).toBe(false);
    vi.stubEnv("EVAL_SERVICES", "real");
    expect(evalServicesMode()).toBe("real");
    vi.stubEnv("EVAL_SERVICES", "bogus");
    expect(isMockServices()).toBe(true);
  });
});

describe("withLiteFallback", () => {
  it("serves unavailable Track B methods from lite, keeps working ones on Track B", async () => {
    const primary = stub({
      qualify: async () => "trackB",
      runSuite: async () => { throw new EvalServiceUnavailableError("runSuite", "not wired"); },
    });
    const lite = stub({ qualify: async () => "lite", runSuite: async () => "lite-run" });
    const s = withLiteFallback(primary, lite) as unknown as Record<string, () => Promise<unknown>>;
    await expect(s.qualify!()).resolves.toBe("trackB");
    await expect(s.runSuite!()).resolves.toBe("lite-run");
  });
  it("propagates other errors instead of falling back", async () => {
    const lite = vi.fn(async () => "lite");
    const s = withLiteFallback(stub({ auditTrace: async () => { throw new Error("boom"); } }), stub({ auditTrace: lite })) as unknown as Record<string, () => Promise<unknown>>;
    await expect(s.auditTrace!()).rejects.toThrow("boom");
    expect(lite).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
// @ts-ignore -- app alias; resolved by vitest (see vitest.config.ts), not by the core tsconfig.
import { mockServices } from "@/server/services";
import { runConformance, summarize, makeRecordingContext } from "./conformance";
import type { EvalServices } from "./services";

describe("conformance harness vs MOCK services", () => {
  it("passes every check", async () => {
    const checks = await runConformance(mockServices as EvalServices, { skipSuite: false });
    const failed = checks.filter((c) => c.status === "fail");
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(summarize(checks).passed).toBeGreaterThan(10);
  });

  it("detects a broken implementation", async () => {
    const bad: EvalServices = {
      ...(mockServices as EvalServices),
      async checkTarget() { return { ok: true, detail: "fine" }; },
      async auditTrace() { return { findings: [], claimsChecked: 0 }; },
    };
    const failed = (await runConformance(bad)).filter((c) => c.status === "fail").map((c) => c.group);
    expect(failed).toContain("checkTarget");
    expect(failed).toContain("auditTrace");
  });

  it("flags paid calls under zero budget", async () => {
    const bad: EvalServices = {
      ...(mockServices as EvalServices),
      async auditTrace(ctx, trace, sp) {
        await ctx.recordCost({ source: "naive", microUsd: 100, meta: {} });
        return (mockServices as EvalServices).auditTrace(ctx, trace, sp);
      },
    };
    const budget = (await runConformance(bad)).find((c) => c.group === "budget");
    expect(budget?.status).toBe("fail");
  });

  it("recording context records costs", async () => {
    const r = makeRecordingContext(5);
    await r.ctx.recordCost({ source: "naive", microUsd: 1, meta: {} });
    expect(r.costs).toHaveLength(1);
  });
});

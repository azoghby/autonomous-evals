import { describe, expect, it, vi } from "vitest";

vi.mock("./store", () => ({ drizzleRuntimeDeps: () => { throw new Error("db not available in tests"); } }));

import { GatewayError } from "@ae/core/ai/gateway";
import { runCompanyAgent } from "./runtime";
import { memoryRuntime } from "./runtime.testing";

const env = { COMPANY_AGENTS_DAILY_BUDGET_USD: "1" };

describe("runCompanyAgent", () => {
  it("records an activity row and costs against company:<id>", async () => {
    const m = memoryRuntime();
    const r = await runCompanyAgent("market_research", { trigger: "manual", deps: m.deps, env }, async (ctx) => {
      await ctx.gateway.recordCost({ source: "ai_gateway", microUsd: 1234, meta: {} });
      ctx.log("did_thing", { n: 1 });
      return { summary: "ok", publicSummary: "ok", counts: { briefs: 1 } };
    });
    expect(r.status).toBe("ok");
    expect(m.costs[0]).toMatchObject({ agent: "company:market_research", microUsd: 1234 });
    expect(m.activities[0]).toMatchObject({ status: "ok", costMicroUsd: 1234, counts: { briefs: 1 } });
    expect((m.activities[0].detail?.events as unknown[]).length).toBe(1);
  });

  it("skips when the toggle is off", async () => {
    const m = memoryRuntime();
    m.toggles.set("outreach", false);
    const fn = vi.fn();
    const r = await runCompanyAgent("outreach", { trigger: "cron", deps: m.deps, env }, fn);
    expect(r).toMatchObject({ status: "skipped", reason: "disabled" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("defaults contact-capable agents off in production", async () => {
    const m = memoryRuntime();
    const prod = { ...env, VERCEL_ENV: "production" };
    expect((await runCompanyAgent("outreach", { trigger: "cron", deps: m.deps, env: prod }, async () => ({ summary: "", publicSummary: "" }))).status).toBe("skipped");
    expect((await runCompanyAgent("prospecting", { trigger: "cron", deps: m.deps, env: prod }, async () => ({ summary: "", publicSummary: "" }))).status).toBe("ok");
  });

  it("skips when the company daily budget is spent", async () => {
    const m = memoryRuntime({ spentToday: 1_000_000 });
    const r = await runCompanyAgent("planner", { trigger: "cron", deps: m.deps, env }, async () => ({ summary: "", publicSummary: "" }));
    expect(r).toMatchObject({ status: "skipped", reason: "daily_budget_exhausted" });
  });

  it("caps the run budget at what is left today and marks budget exhaustion", async () => {
    const m = memoryRuntime({ spentToday: 900_000 });
    const r = await runCompanyAgent("prospecting", { trigger: "cron", deps: m.deps, env }, async (ctx) => {
      expect(ctx.budgetMicroUsd).toBe(100_000);
      await ctx.gateway.recordCost({ source: "ai_gateway", microUsd: 100_000, meta: {} });
      expect(ctx.gateway.budgetMicroUsd).toBe(0);
      throw new GatewayError("budget_exhausted", "x");
    });
    expect(r.status).toBe("budget");
    expect(m.activities[0].status).toBe("budget");
  });

  it("skips overlapping runs via the lock", async () => {
    const m = memoryRuntime();
    let inner: unknown;
    await runCompanyAgent("planner", { trigger: "cron", deps: m.deps, env }, async () => {
      inner = await runCompanyAgent("planner", { trigger: "cron", deps: m.deps, env }, async () => ({ summary: "", publicSummary: "" }));
      return { summary: "", publicSummary: "" };
    });
    expect(inner).toMatchObject({ status: "skipped", reason: "locked" });
  });

  it("records failures without throwing", async () => {
    const m = memoryRuntime();
    const r = await runCompanyAgent("planner", { trigger: "cron", deps: m.deps, env }, async () => { throw new Error("boom"); });
    expect(r).toMatchObject({ status: "failed", error: "boom" });
  });
});

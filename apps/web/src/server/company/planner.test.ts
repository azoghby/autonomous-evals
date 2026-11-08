import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./store", () => ({ drizzleRuntimeDeps: () => { throw new Error("db not available in tests"); } }));
vi.mock("./metrics", () => ({ getCompanyMetrics: async () => { throw new Error("db not available in tests"); } }));
vi.mock("@ae/core/db/client", () => ({ db: () => { throw new Error("no db"); }, schema: {} }));

import { GatewayError } from "@ae/core/ai/gateway";
import type { CompanyMetrics } from "@ae/core/company/planner";
import type { CompanyAgentId } from "@ae/core/company/registry";
import { runPlannerAgent, type GenerateFn, type PlannerStore, type StoredTask } from "./planner";
import { memoryRuntime } from "./runtime.testing";
import type { RunResult } from "./runtime";

const NOW = new Date("2026-11-07T06:30:00Z");
const env = { COMPANY_AGENTS_DAILY_BUDGET_USD: "5" };

const metrics: CompanyMetrics = {
  generatedAt: NOW.toISOString(), revenueCents: { d1: 0, d7: 0, d30: 0 }, customersByPlan: {},
  sandboxRuns7d: { byStatus: {}, failed: 0 }, prospects: { byStatus: {}, newLast1d: 0 },
  outreach: { byStatus: {}, pendingApproval: 0 }, spendMicroUsd: { companyToday: 0, company7d: 0, totalModel7d: 0 },
  agentFailures1d: 0, marketBrief: null,
};

function fakeStore(ranToday: string[] = []) {
  const calls = { plans: [] as unknown[], replaced: [] as unknown[], updates: [] as Array<{ id: string; status: string; activityId?: string }> };
  const store: PlannerStore = {
    getMetrics: async () => metrics,
    upsertPlan: async (r) => { calls.plans.push(r); },
    replaceOpenTasks: async (_d, tasks) => { calls.replaced.push(tasks); return tasks.map((t, i): StoredTask => ({ id: `t${i}`, assignee: t.assignee, title: t.title, priority: t.priority })); },
    updateTask: async (id, patch) => { calls.updates.push({ id, ...patch }); },
    agentsRunToday: async () => new Set(ranToday),
  };
  return { store, calls };
}

const modelPlan = {
  summary: "Line one\nLine two",
  tasks: [
    { assignee: "prospecting", title: "Find leads", rationale: "r", priority: 1 },
    { assignee: "outreach", title: "Draft", rationale: "r", priority: 2 },
    { assignee: "planner", title: "self", rationale: "", priority: 1 },
  ],
};
const gen = (obj: unknown): GenerateFn => (async () => ({ object: obj })) as unknown as GenerateFn;
const res = (agentId: CompanyAgentId, status: "ok" | "skipped" | "failed" | "budget"): RunResult =>
  status === "skipped" ? { status, reason: "disabled", agentId } : { status, agentId, activityId: `act-${agentId}`, costMicroUsd: 0 };

describe("runPlannerAgent", () => {
  it("persists plan and open tasks without dispatching when no dispatch dep", async () => {
    const m = memoryRuntime(); const { store, calls } = fakeStore();
    const r = await runPlannerAgent({ trigger: "manual", now: NOW, env }, { runtime: m.deps, store, generate: gen(modelPlan) });
    expect(r.status).toBe("ok");
    expect(calls.plans).toHaveLength(1);
    expect(calls.plans[0]).toMatchObject({ planDate: "2026-11-07", summary: "Line one\nLine two" });
    expect((calls.replaced[0] as unknown[]).length).toBe(2); // planner task dropped
    expect(calls.updates).toEqual([]);
    expect(m.activities[0].counts).toEqual({ tasks: 2, dispatched: 0, skipped: 0, failed: 0 });
  });

  it("maps dispatch results to task statuses and activity ids", async () => {
    const m = memoryRuntime(); const { store, calls } = fakeStore();
    const dispatch = vi.fn(async (a: CompanyAgentId) => res(a, a === "prospecting" ? "ok" : "skipped"));
    const r = await runPlannerAgent({ trigger: "cron", now: NOW, env }, { runtime: m.deps, store, generate: gen(modelPlan), dispatch });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(calls.updates).toEqual([
      { id: "t0", status: "running" }, { id: "t0", status: "done", activityId: "act-prospecting" },
      { id: "t1", status: "running" }, { id: "t1", status: "skipped", activityId: undefined },
    ]);
    expect(m.activities[0].counts).toEqual({ tasks: 2, dispatched: 1, skipped: 1, failed: 0 });
  });

  it("marks failed/budget/thrown dispatches as failed", async () => {
    const m = memoryRuntime(); const { store } = fakeStore();
    const dispatch = vi.fn(async (a: CompanyAgentId): Promise<RunResult> => { if (a === "outreach") throw new Error("boom"); return res(a, "budget"); });
    await runPlannerAgent({ trigger: "cron", now: NOW, env }, { runtime: m.deps, store, generate: gen(modelPlan), dispatch });
    expect(m.activities[0].counts).toMatchObject({ failed: 2, dispatched: 0 });
  });

  it("skips agents that already ran today without dispatching them", async () => {
    const m = memoryRuntime(); const { store } = fakeStore(["prospecting"]);
    const dispatch = vi.fn(async (a: CompanyAgentId) => res(a, "ok"));
    await runPlannerAgent({ trigger: "cron", now: NOW, env }, { runtime: m.deps, store, generate: gen(modelPlan), dispatch });
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual(["outreach"]);
    expect(m.activities[0].counts).toMatchObject({ skipped: 1, dispatched: 1 });
  });

  it("does not dispatch on dry runs", async () => {
    const m = memoryRuntime(); const { store } = fakeStore();
    const dispatch = vi.fn();
    await runPlannerAgent({ trigger: "manual", dryRun: true, now: NOW, env }, { runtime: m.deps, store, generate: gen(modelPlan), dispatch });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("falls back to the deterministic plan on malformed model output and logs it", async () => {
    const m = memoryRuntime(); const { store, calls } = fakeStore();
    const generate = (async () => { throw new GatewayError("malformed_output", "bad json"); }) as unknown as GenerateFn;
    const r = await runPlannerAgent({ trigger: "cron", now: NOW, env }, { runtime: m.deps, store, generate });
    expect(r.status).toBe("ok");
    expect((calls.plans[0] as { summary: string }).summary).toContain("Fallback plan");
    const events = m.activities[0].detail?.events as Array<{ event: string }>;
    expect(events.some((e) => e.event === "plan_model_failed")).toBe(true);
    expect(m.activities[0].detail?.usedFallback).toBe(true);
  });

  it("skips when the planner is disabled and keeps public summary free of titles", async () => {
    const m = memoryRuntime(); m.toggles.set("planner", false); const { store, calls } = fakeStore();
    const off = await runPlannerAgent({ trigger: "cron", now: NOW, env }, { runtime: m.deps, store, generate: gen(modelPlan) });
    expect(off).toMatchObject({ status: "skipped", reason: "disabled" });
    expect(calls.plans).toHaveLength(0);
    m.toggles.clear();
    await runPlannerAgent({ trigger: "cron", now: NOW, env }, { runtime: m.deps, store, generate: gen(modelPlan) });
    expect(m.activities[0].publicSummary).not.toMatch(/Find leads/);
  });
});

import "server-only";
/**
 * CEO / Planner agent. One model call over aggregate metrics -> a short daily plan + tasks for the other agents.
 * It never sends messages or changes budgets; dispatched agents enforce their own toggles and budgets.
 */
import { and, asc, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { GatewayError, generateStructured } from "@ae/core/ai/gateway";
import { withNaive } from "./naive-runtime";
import { COMPANY_AGENTS, type CompanyAgentId } from "@ae/core/company/registry";
import { dayKey, startOfUtcDay } from "@ae/core/company/policy";
import {
  ASSIGNABLE_AGENTS, DailyPlanSchema, fallbackPlan, sanitizePlan, taskStatusForRun,
  type CompanyMetrics, type PlanTask, type SanitizedPlan, type TaskStatus,
} from "@ae/core/company/planner";
import { runCompanyAgent, type AgentRunContext, type RunOptions, type RunResult } from "./runtime";
import { getCompanyMetrics } from "./metrics";

export type CompanyRunOptions = Omit<RunOptions, "deps">;
export type DispatchFn = (assignee: CompanyAgentId, taskId: string) => Promise<RunResult>;
export type GenerateFn = typeof generateStructured;

export interface StoredTask { id: string; assignee: CompanyAgentId; title: string; priority: number }

export interface PlannerStore {
  getMetrics(now: Date): Promise<CompanyMetrics>;
  upsertPlan(row: { planDate: string; summary: string; metrics: CompanyMetrics; activityId: string }): Promise<void>;
  /** Replaces still-open planner tasks of that day with the given ones; returns inserted rows. */
  replaceOpenTasks(planDate: string, tasks: PlanTask[]): Promise<StoredTask[]>;
  updateTask(id: string, patch: { status: TaskStatus; activityId?: string }): Promise<void>;
  /** Agents that already completed (ok) a run since 00:00 UTC. */
  agentsRunToday(now: Date): Promise<Set<string>>;
}

export interface PlannerDeps {
  runtime?: RunOptions["deps"];
  generate: GenerateFn;
  store: PlannerStore;
  /** Default: none (tasks stay "open"). The orchestrator wires this to the other agents' entry points. */
  dispatch?: DispatchFn;
}

export function buildPlannerPrompt(m: CompanyMetrics, planDate: string): string {
  return [
    `Today is ${planDate} (UTC). Company metrics (aggregate counts, revenue in cents, spend in micro-USD):`,
    JSON.stringify(m),
    "",
    `Write today's plan. "summary": plain text, 3-6 short lines, at most 700 characters.`,
    `"tasks": at most ${ASSIGNABLE_AGENTS.length}, at most one per agent, each { assignee (one of ${ASSIGNABLE_AGENTS.join(", ")}), title, rationale, priority 1-5 (1 = highest) }.`,
    "Skip an agent if there is nothing valuable for it to do today. Mention any failures or a growing approval queue in the summary.",
  ].join("\n");
}

async function planWithModel(deps: PlannerDeps, ctx: AgentRunContext, m: CompanyMetrics, planDate: string): Promise<{ plan: SanitizedPlan; usedFallback: boolean }> {
  try {
    const res = await deps.generate({
      model: "sonnet", system: COMPANY_AGENTS.planner.system, prompt: buildPlannerPrompt(m, planDate),
      schema: DailyPlanSchema, ctx: ctx.gateway, maxOutputTokens: 900,
    });
    return { plan: sanitizePlan(res.object), usedFallback: false };
  } catch (err) {
    if (err instanceof GatewayError && err.code === "budget_exhausted") throw err;
    ctx.log("plan_model_failed", { error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    return { plan: fallbackPlan(m), usedFallback: true };
  }
}

interface DispatchCounts { dispatched: number; skipped: number; failed: number }

async function dispatchTasks(deps: PlannerDeps, ctx: AgentRunContext, tasks: StoredTask[]): Promise<DispatchCounts> {
  const counts: DispatchCounts = { dispatched: 0, skipped: 0, failed: 0 };
  if (!deps.dispatch || ctx.dryRun) return counts;
  const ranToday = await deps.store.agentsRunToday(ctx.now);
  for (const task of tasks) {
    if (ranToday.has(task.assignee)) {
      await deps.store.updateTask(task.id, { status: "skipped" });
      ctx.log("task_skipped_already_ran", { assignee: task.assignee });
      counts.skipped++;
      continue;
    }
    await deps.store.updateTask(task.id, { status: "running" });
    let status: ReturnType<typeof taskStatusForRun> = "failed";
    let activityId: string | undefined;
    try {
      const r = await deps.dispatch(task.assignee, task.id);
      status = taskStatusForRun(r.status);
      activityId = "activityId" in r ? r.activityId : undefined;
    } catch (err) {
      ctx.log("dispatch_threw", { assignee: task.assignee, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
    await deps.store.updateTask(task.id, { status, activityId });
    if (status === "done") counts.dispatched++; else if (status === "skipped") counts.skipped++; else counts.failed++;
  }
  return counts;
}

export async function runPlannerAgent(opts: CompanyRunOptions = { trigger: "cron" }, deps: Partial<PlannerDeps> = {}): Promise<RunResult> {
  const full: PlannerDeps = { generate: withNaive("planner", generateStructured), store: drizzlePlannerStore(), ...deps };
  return runCompanyAgent("planner", { ...opts, deps: deps.runtime }, async (ctx) => {
    const planDate = dayKey(ctx.now);
    const metrics = await full.store.getMetrics(ctx.now);
    const { plan, usedFallback } = await planWithModel(full, ctx, metrics, planDate);
    await full.store.upsertPlan({ planDate, summary: plan.summary, metrics, activityId: ctx.activityId });
    const stored = await full.store.replaceOpenTasks(planDate, plan.tasks);
    const counts = await dispatchTasks(full, ctx, stored);
    const nums = { tasks: stored.length, ...counts };
    return {
      summary: `${plan.summary}\n\nTasks: ${plan.tasks.map((t) => `${t.assignee}: ${t.title}`).join("; ") || "none"}`,
      publicSummary: `Wrote today's plan: ${nums.tasks} task(s) assigned, ${nums.dispatched} run, ${nums.skipped} skipped, ${nums.failed} failed.`,
      counts: nums,
      detail: { planDate, usedFallback, dispatchEnabled: Boolean(full.dispatch) && !ctx.dryRun },
    };
  });
}

/* ---------------- DB-backed store and readers ---------------- */

export function drizzlePlannerStore(): PlannerStore {
  const t = schema.companyTasks, p = schema.companyPlans, a = schema.companyAgentActivity;
  return {
    getMetrics: getCompanyMetrics,
    async upsertPlan(row) {
      const values = { summary: row.summary, metrics: row.metrics as unknown as Record<string, unknown>, activityId: row.activityId };
      await db().insert(p).values({ planDate: row.planDate, ...values }).onConflictDoUpdate({ target: p.planDate, set: values });
    },
    async replaceOpenTasks(planDate, tasks) {
      await db().delete(t).where(and(eq(t.planDate, planDate), eq(t.status, "open"), eq(t.createdBy, "planner")));
      if (tasks.length === 0) return [];
      const rows = await db().insert(t).values(tasks.map((x) => ({ planDate, assignee: x.assignee, title: x.title, rationale: x.rationale, priority: x.priority })))
        .returning({ id: t.id, assignee: t.assignee, title: t.title, priority: t.priority });
      return rows as StoredTask[];
    },
    async updateTask(id, patch) {
      await db().update(t).set({ status: patch.status, ...(patch.activityId ? { activityId: patch.activityId } : {}), updatedAt: new Date() }).where(eq(t.id, id));
    },
    async agentsRunToday(now) {
      const rows = await db().selectDistinct({ agentId: a.agentId }).from(a)
        .where(and(gte(a.startedAt, startOfUtcDay(now)), eq(a.status, "ok"), inArray(a.agentId, [...ASSIGNABLE_AGENTS]), ne(a.dryRun, true)));
      return new Set(rows.map((r) => r.agentId));
    },
  };
}

export interface DailyPlanSummary {
  planDate: string;
  summary: string;
  tasks: Array<{ assignee: string; title: string; status: string; priority: number }>;
}

/** Today's (or the given day's) plan, or null if none. Imported by the daily report and the operator digest. */
export async function getDailyPlanSummary(date: Date = new Date()): Promise<DailyPlanSummary | null> {
  const planDate = dayKey(date);
  const [plan] = await db().select({ planDate: schema.companyPlans.planDate, summary: schema.companyPlans.summary })
    .from(schema.companyPlans).where(eq(schema.companyPlans.planDate, planDate)).limit(1);
  if (!plan) return null;
  const tasks = await listTasks({ planDate, limit: 20 });
  return { planDate: plan.planDate, summary: plan.summary, tasks: tasks.map(({ assignee, title, status, priority }) => ({ assignee, title, status, priority })) };
}

export async function listTasks(opts: { planDate?: string; limit?: number } = {}) {
  const t = schema.companyTasks;
  const q = db().select({ id: t.id, planDate: t.planDate, assignee: t.assignee, title: t.title, rationale: t.rationale, priority: t.priority, status: t.status, activityId: t.activityId, createdAt: t.createdAt }).from(t);
  const filtered = opts.planDate ? q.where(eq(t.planDate, opts.planDate)) : q;
  return filtered.orderBy(desc(t.planDate), asc(t.priority)).limit(Math.min(opts.limit ?? 50, 200));
}

export async function listPlans(limit = 14) {
  const p = schema.companyPlans;
  return db().select({ planDate: p.planDate, summary: p.summary, activityId: p.activityId, createdAt: p.createdAt })
    .from(p).orderBy(desc(p.planDate)).limit(Math.min(limit, 90));
}

/** Pure logic for the CEO / Planner agent: schemas, plan sanitising, deterministic fallback. No I/O. */
import { z } from "zod";

export const ASSIGNABLE_AGENTS = ["market_research", "prospecting", "outreach", "onboarding"] as const;
export type AssignableAgent = (typeof ASSIGNABLE_AGENTS)[number];

export const MAX_PLAN_TASKS = 6;
export const MAX_SUMMARY_CHARS = 700;

/** Model-facing schema: assignee is a free string so unknown assignees are dropped by sanitizePlan, not rejected. */
export const DailyPlanSchema = z.object({
  summary: z.string().min(1).max(2000),
  tasks: z.array(z.object({
    assignee: z.string().min(1).max(60),
    title: z.string().min(1).max(200),
    rationale: z.string().max(600).default(""),
    priority: z.number().int().min(1).max(5).default(3),
  })).max(20).default([]),
});
export type DailyPlan = z.infer<typeof DailyPlanSchema>;

export interface PlanTask { assignee: AssignableAgent; title: string; rationale: string; priority: number }
export interface SanitizedPlan { summary: string; tasks: PlanTask[] }

const CountMap = z.record(z.string(), z.number());
/** Aggregate company metrics. Counts and money only: no PII. */
export const CompanyMetricsSchema = z.object({
  generatedAt: z.string(),
  revenueCents: z.object({ d1: z.number(), d7: z.number(), d30: z.number() }),
  customersByPlan: CountMap,
  sandboxRuns7d: z.object({ byStatus: CountMap, failed: z.number() }),
  prospects: z.object({ byStatus: CountMap, newLast1d: z.number() }),
  outreach: z.object({ byStatus: CountMap, pendingApproval: z.number() }),
  spendMicroUsd: z.object({ companyToday: z.number(), company7d: z.number(), totalModel7d: z.number() }),
  agentFailures1d: z.number(),
  marketBrief: z.object({ date: z.string(), headline: z.string() }).nullable(),
});
export type CompanyMetrics = z.infer<typeof CompanyMetricsSchema>;

export interface SanitizeCtx { maxTasks?: number }

const isAssignable = (v: string): v is AssignableAgent => (ASSIGNABLE_AGENTS as readonly string[]).includes(v);
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function clampSummary(text: string): string {
  const t = text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  return t.length <= MAX_SUMMARY_CHARS ? t : `${t.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`;
}

/**
 * Drops tasks for the planner itself or unknown assignees, dedupes by assignee+title, allows at most one task
 * (= one run) per agent per day (keeping the highest priority, i.e. lowest number; first-listed on ties),
 * caps the total, and orders by priority.
 */
export function sanitizePlan(plan: DailyPlan, ctx: SanitizeCtx = {}): SanitizedPlan {
  const max = Math.min(ctx.maxTasks ?? MAX_PLAN_TASKS, MAX_PLAN_TASKS);
  const seen = new Set<string>();
  const best = new Map<AssignableAgent, PlanTask & { order: number }>();
  plan.tasks.forEach((t, order) => {
    const assignee = clean(t.assignee).toLowerCase();
    const title = clean(t.title);
    if (!isAssignable(assignee) || !title) return;
    const key = `${assignee}|${title.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const task = { assignee, title, rationale: clean(t.rationale ?? ""), priority: Math.min(5, Math.max(1, Math.round(t.priority ?? 3))), order };
    const cur = best.get(assignee);
    if (!cur || task.priority < cur.priority) best.set(assignee, task);
  });
  const tasks = [...best.values()].sort((a, b) => a.priority - b.priority || a.order - b.order).slice(0, max)
    .map(({ order: _order, ...t }) => t);
  return { summary: clampSummary(plan.summary), tasks };
}

/** Deterministic plan used when the model call fails. Reacts to the approval queue and funnel only. */
export function fallbackPlan(m: CompanyMetrics): SanitizedPlan {
  const tasks: PlanTask[] = [];
  const newLeads = m.prospects.byStatus.new ?? 0;
  const queueShort = m.outreach.pendingApproval < 10;
  if (!m.marketBrief) {
    tasks.push({ assignee: "market_research", title: "Produce today's market brief", rationale: "No brief on record.", priority: 2 });
  }
  if (queueShort) {
    tasks.push({ assignee: "prospecting", title: "Find new qualified prospects", rationale: "Approval queue is short; refill the funnel.", priority: 2 });
  }
  if (newLeads > 0 && queueShort) {
    tasks.push({ assignee: "outreach", title: "Draft outreach for new leads", rationale: `${newLeads} lead(s) are waiting for a draft.`, priority: 3 });
  }
  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const lines = [
    `Fallback plan (model output unavailable) for ${m.generatedAt.slice(0, 10)}.`,
    `Revenue 1d/7d/30d: ${usd(m.revenueCents.d1)} / ${usd(m.revenueCents.d7)} / ${usd(m.revenueCents.d30)}.`,
    `${m.outreach.pendingApproval} draft(s) awaiting founder approval; ${newLeads} new lead(s).`,
    `${m.sandboxRuns7d.failed} failed sandbox run(s) this week, ${m.agentFailures1d} agent failure(s) in the last day.`,
  ];
  return sanitizePlan({ summary: lines.join("\n"), tasks });
}

export type TaskStatus = "open" | "running" | "done" | "skipped" | "failed";

/** Maps a dispatched run's status to a final task status. */
export function taskStatusForRun(status: "ok" | "skipped" | "failed" | "budget"): Exclude<TaskStatus, "open" | "running"> {
  if (status === "ok") return "done";
  if (status === "skipped") return "skipped";
  return "failed";
}

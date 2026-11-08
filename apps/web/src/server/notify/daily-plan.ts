import "server-only";

/** Pure: the CEO planner's daily plan as short bullet lines for the founder's daily report. */
export function planToBullets(plan: { summary: string; tasks: Array<{ assignee: string; title: string; status: string }> } | null): string[] | null {
  if (!plan) return null;
  const lines = plan.summary.split("\n").map((l) => l.replace(/^[-*\s]+/, "").trim()).filter(Boolean);
  const tasks = plan.tasks.map((t) => `${t.assignee}: ${t.title} (${t.status})`);
  const out = [...lines, ...tasks].slice(0, 12);
  return out.length ? out : null;
}

/**
 * Today's plan from the company CEO planner agent (apps/web/src/server/company/planner.ts), or null.
 * Fast (one small query) and never throws.
 */
export async function getTodaysPlan(now: Date): Promise<string[] | null> {
  try {
    const { getDailyPlanSummary } = await import("../company/planner");
    return planToBullets(await getDailyPlanSummary(now));
  } catch (err) {
    console.error("daily plan lookup failed", err instanceof Error ? err.message : err);
    return null;
  }
}

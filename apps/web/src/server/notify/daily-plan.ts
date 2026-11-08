import "server-only";

/**
 * Hook for the company CEO planner agent (apps/web/src/server/company/**): return today's plan as short
 * bullet lines and it is included in the founder's daily report. Returning null omits the section.
 * Replace the body with a call into the planner once it exists; keep it fast (< 5s) and never throw.
 */
export async function getTodaysPlan(_now: Date): Promise<string[] | null> {
  return null;
}

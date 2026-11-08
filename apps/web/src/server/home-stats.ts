/** Read-only proof stats for the homepage strip. Never throws: any DB error yields null (the strip renders nothing). */
import { sql } from "drizzle-orm";
import { db } from "../../../../packages/core/src/db/client";

export interface HomeStats {
  /** Distinct open-source agents (name before " · "), each may run on several models. */
  agents: number;
  /** Distinct (agent, model) pairings with at least one graded run. */
  pairings: number;
  /** Sum of total over the latest graded run per agent row (same basis as the leaderboard). */
  scenarios: number;
  /** Median of cost_micro_usd / total over runs, in USD per scenario. Null when no run has a cost. */
  medianCostPerScenarioUsd: number | null;
  /** Latest run time, ISO string. */
  asOf: string;
}

interface Row {
  agents: number | string | null;
  pairings: number | string | null;
  scenarios: number | string | null;
  median_micro: number | string | null;
  as_of: string | Date | null;
}

const MICRO = 1_000_000;

export async function getHomeStats(): Promise<HomeStats | null> {
  try {
    const res = await db().execute(sql`
      SELECT
        count(DISTINCT split_part(a.name, ' · ', 1)) AS agents,
        count(DISTINCT (a.slug, a.model)) AS pairings,
        coalesce(sum(r.total), 0) AS scenarios,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY r.cost_micro_usd::float8 / r.total)
          FILTER (WHERE r.total > 0 AND r.cost_micro_usd > 0) AS median_micro,
        max(r.ran_at) AS as_of
      FROM (
        -- Latest graded run per agent row, matching the leaderboard (re-runs must not inflate the totals).
        SELECT DISTINCT ON (agent_id) agent_id, total, cost_micro_usd, ran_at
        FROM public_agent_runs
        WHERE suite_version = 'standard-v1' AND total > 0
        ORDER BY agent_id, ran_at DESC
      ) r
      JOIN public_agents a ON a.id = r.agent_id
      WHERE a.visibility = 'public' AND (a.active OR a.status = 'paused')`);
    const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as Row[];
    const row = rows[0];
    if (!row || row.as_of == null) return null;
    const agents = Number(row.agents);
    const scenarios = Number(row.scenarios);
    if (!Number.isFinite(agents) || !Number.isFinite(scenarios) || agents <= 0 || scenarios <= 0) return null;
    const median = row.median_micro == null ? null : Number(row.median_micro) / MICRO;
    return {
      agents,
      pairings: Number(row.pairings),
      scenarios,
      medianCostPerScenarioUsd: median != null && Number.isFinite(median) ? median : null,
      asOf: new Date(row.as_of).toISOString(),
    };
  } catch (e) {
    console.error("[home-stats] load failed", e instanceof Error ? e.message : e);
    return null;
  }
}

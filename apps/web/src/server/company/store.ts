import "server-only";
/** Drizzle-backed persistence for the company runtime (activity, toggles, costs, advisory locks). */
import { and, eq, gte, like, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { startOfUtcDay } from "@ae/core/company/policy";
import type { CompanyAgentId } from "@ae/core/company/registry";
import type { RuntimeDeps } from "./runtime";

export async function getAgentToggle(agent: CompanyAgentId): Promise<boolean | null> {
  const s = schema.companyAgentSettings;
  const [row] = await db().select({ enabled: s.enabled }).from(s).where(eq(s.agentId, agent)).limit(1);
  return row ? row.enabled : null;
}

export async function getAgentToggles(): Promise<Map<string, boolean>> {
  const s = schema.companyAgentSettings;
  const rows = await db().select({ agentId: s.agentId, enabled: s.enabled }).from(s);
  return new Map(rows.map((r) => [r.agentId, r.enabled]));
}

export async function setAgentToggle(agent: CompanyAgentId, enabled: boolean, by: string): Promise<void> {
  const s = schema.companyAgentSettings;
  await db().insert(s).values({ agentId: agent, enabled, updatedBy: by, updatedAt: new Date() })
    .onConflictDoUpdate({ target: s.agentId, set: { enabled, updatedBy: by, updatedAt: new Date() } });
}

/** Company agents' spend since 00:00 UTC (costs.agent like 'company:%'). */
export async function companySpentTodayMicroUsd(now: Date): Promise<number> {
  const c = schema.costs;
  const [row] = await db().select({ total: sql<string>`coalesce(sum(${c.microUsd}), 0)` }).from(c)
    .where(and(like(c.agent, "company:%"), gte(c.createdAt, startOfUtcDay(now))));
  return Number(row?.total ?? 0);
}

/** Session advisory lock on a dedicated connection (same pattern as public-agent-cron). */
export async function withAdvisoryLock<T>(key: bigint, fn: () => Promise<T>): Promise<{ locked: true } | { locked: false; value: T }> {
  const { Pool } = await import("@neondatabase/serverless");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    const { rows } = await client.query("select pg_try_advisory_lock($1::bigint) as ok", [key.toString()]);
    if (!rows[0]?.ok) return { locked: true };
    try {
      return { locked: false, value: await fn() };
    } finally {
      await client.query("select pg_advisory_unlock($1::bigint)", [key.toString()]).catch(() => {});
    }
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

export function drizzleRuntimeDeps(): RuntimeDeps {
  const a = schema.companyAgentActivity;
  return {
    getToggle: getAgentToggle,
    spentTodayMicroUsd: companySpentTodayMicroUsd,
    withLock: withAdvisoryLock,
    async insertActivity(r) {
      const [row] = await db().insert(a).values({
        agentId: r.agentId, trigger: r.trigger, status: "running", budgetMicroUsd: r.budgetMicroUsd, dryRun: r.dryRun, startedAt: r.startedAt,
      }).returning({ id: a.id });
      return row.id;
    },
    async finishActivity(id, f) {
      await db().update(a).set({
        status: f.status, summary: f.summary, publicSummary: f.publicSummary, counts: f.counts, detail: f.detail,
        costMicroUsd: f.costMicroUsd, error: f.error, finishedAt: new Date(),
      }).where(eq(a.id, id));
    },
    async insertCost(r) {
      await db().insert(schema.costs).values({ jobId: null, source: r.source, agent: r.agent, microUsd: r.microUsd, meta: r.meta });
    },
  };
}

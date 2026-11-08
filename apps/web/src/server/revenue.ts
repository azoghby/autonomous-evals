import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";

export const DEFAULT_REVENUE_SINCE = "2026-11-07T00:00:00Z";

export function revenueSince(env: string | undefined = process.env.REVENUE_COUNTER_SINCE): Date {
  const d = new Date(env || DEFAULT_REVENUE_SINCE);
  return Number.isNaN(d.getTime()) ? new Date(DEFAULT_REVENUE_SINCE) : d;
}

export interface RevenueStats { revenueCents: number; paidJobs: number; since: string }

/** Money actually taken: live, non-mock, status paid (fixed amount) or captured (captured amount). Never authorized/released/needs_refund. */
export async function getRevenueStats(since: Date = revenueSince()): Promise<RevenueStats> {
  const p = schema.payments;
  const recognized = sql`case ${p.status} when 'captured' then coalesce(${p.capturedAmountCents}, 0) else ${p.amountCents} end`;
  const [row] = await db().select({
    cents: sql<string>`coalesce(sum(${recognized}), 0)`,
    jobs: sql<string>`count(distinct ${p.jobId}) filter (where ${recognized} > 0)`,
  }).from(p)
    .innerJoin(schema.jobs, eq(schema.jobs.id, p.jobId))
    .where(and(
      eq(p.environment, "live"),
      eq(schema.jobs.isMock, false),
      inArray(p.status, ["paid", "captured"]),
      gte(p.createdAt, since),
    ));
  return { revenueCents: Number(row?.cents ?? 0), paidJobs: Number(row?.jobs ?? 0), since: since.toISOString() };
}

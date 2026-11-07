import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { JOB_BUDGET_MICRO_USD } from "../contracts/index";
import type { BudgetReserver, ReserveResult } from "../contracts/services";

/** CASE over the single source of truth for per-package caps (JOB_BUDGET_MICRO_USD). */
const capCase = () => sql.join(
  Object.entries(JOB_BUDGET_MICRO_USD).map(([pkg, cap]) => sql`when ${pkg} then ${cap}::bigint`),
  sql` `,
);

/**
 * One statement: remaining = cap - unreleased reservations - recorded costs (same rule as the workflow's
 * budgetCheck), insert only if remaining >= amount, and bump jobs.budget_reserved_micro_usd like withBudget does.
 */
export function reserveStatement(jobId: string, agent: string, microUsd: number) {
  return sql`
    with cap as (
      select j.id, (case j.package::text ${capCase()} end) as cap from jobs j where j.id = ${jobId}
    ), room as (
      select cap.id, cap.cap
        - coalesce((select sum(r.micro_usd) from budget_reservations r where r.job_id = cap.id and r.released_at is null), 0)
        - coalesce((select sum(c.micro_usd) from costs c where c.job_id = cap.id), 0) as remaining
      from cap
    ), ins as (
      insert into budget_reservations (job_id, agent, micro_usd)
      select id, ${agent}, ${microUsd}::bigint from room where remaining >= ${microUsd}::bigint
      returning id, job_id
    ), bump as (
      update jobs set budget_reserved_micro_usd = budget_reserved_micro_usd + ${microUsd}::bigint
      where id in (select job_id from ins)
    )
    select (select id from ins) as reservation_id, (select remaining from room) as remaining`;
}

/** Per-job transaction-scoped advisory lock; the next statement in the same batch sees a fresh snapshot after acquiring it. */
export const lockJobStatement = (jobId: string) => sql`select pg_advisory_xact_lock(hashtext(${jobId}))`;

/**
 * Marks the reservation released and, only if that transition actually happened, decrements the job's
 * reserved counter by the released amount (never below zero).
 */
export function releaseStatement(jobId: string, reservationId: string) {
  return sql`
    with rel as (
      update budget_reservations set released_at = now()
      where id = ${reservationId} and job_id = ${jobId} and released_at is null
      returning job_id, micro_usd
    )
    update jobs set budget_reserved_micro_usd = greatest(0, budget_reserved_micro_usd - (select sum(micro_usd) from rel))
    where id in (select job_id from rel)`;
}

export function createBudgetReserver(jobId: string): BudgetReserver {
  return {
    async reserve(agent, microUsd): Promise<ReserveResult> {
      if (!Number.isSafeInteger(microUsd) || microUsd <= 0) throw new Error("microUsd must be a positive integer");
      // Non-interactive transaction: the xact lock serializes concurrent reservers of this job, and the
      // reserve statement then reads a snapshot taken after the lock was granted (READ COMMITTED).
      const d = db();
      const [, res] = await d.batch([d.execute(lockJobStatement(jobId)), d.execute(reserveStatement(jobId, agent, microUsd))]);
      const row = res.rows[0] as { reservation_id: string | null; remaining: string | number | null } | undefined;
      if (row?.reservation_id) return { ok: true, reservationId: row.reservation_id };
      return { ok: false, remainingMicroUsd: Math.max(0, Number(row?.remaining ?? 0)) };
    },
    async release(reservationId) {
      await db().execute(releaseStatement(jobId, reservationId));
    },
  };
}

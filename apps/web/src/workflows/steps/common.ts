import { FatalError } from "workflow";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { JOB_BUDGET_MICRO_USD } from "@ae/core/contracts/index";
import type { ServiceContext } from "@ae/core/contracts/services";
import { getJob, makeServiceContext, jobKnownCostMicroUsd } from "@/server/job-store";
import { budgetCheck, type BudgetAgent } from "../decisions";

/** Result of a step that may stop on budget exhaustion instead of throwing (so it is never retried). */
export type BudgetResult<T> = { status: "ok"; data: T } | { status: "budget_exceeded"; message: string };

export async function requireJob(jobId: string) {
  const job = await getJob(jobId);
  if (!job) throw new FatalError(`Job ${jobId} not found`);
  return job;
}

/**
 * Reserves per-job budget for one agent-calling stage, runs it, then releases the reservation (actual
 * spend is recorded in costs by the services). A reservation left by a failed attempt is reused, not doubled.
 */
export async function withBudget<T>(
  jobId: string, agent: BudgetAgent, run: (ctx: ServiceContext) => Promise<T>,
): Promise<BudgetResult<T>> {
  const job = await requireJob(jobId);
  const cap = JOB_BUDGET_MICRO_USD[job.package];
  const spent = await jobKnownCostMicroUsd(jobId);
  const open = await db().select().from(schema.budgetReservations)
    .where(and(eq(schema.budgetReservations.jobId, jobId), isNull(schema.budgetReservations.releasedAt)));
  const mine = open.find((r) => r.agent === agent);
  const otherReserved = open.filter((r) => r !== mine).reduce((s, r) => s + r.microUsd, 0);
  const check = budgetCheck(cap, spent, otherReserved, agent);
  if (!check.ok) {
    return {
      status: "budget_exceeded",
      message: `Per-job budget exhausted before the ${agent} stage (cap ${cap}, spent ${spent}, reserved ${otherReserved} micro-USD).`,
    };
  }
  let reservationId = mine?.id;
  if (!reservationId) {
    const [row] = await db().insert(schema.budgetReservations)
      .values({ jobId, agent, microUsd: check.reserve }).returning({ id: schema.budgetReservations.id });
    reservationId = row!.id;
    await db().update(schema.jobs).set({ budgetReservedMicroUsd: sql`${schema.jobs.budgetReservedMicroUsd} + ${check.reserve}` })
      .where(eq(schema.jobs.id, jobId));
  }
  const ctx = await makeServiceContext(jobId);
  const data = await run(ctx);
  await db().update(schema.budgetReservations).set({ releasedAt: new Date() }).where(eq(schema.budgetReservations.id, reservationId));
  return { status: "ok", data };
}

import type { IntakeInput } from "@ae/core/contracts/index";
import { getJobWithDecryptedCredentials } from "@/server/job-store";

const ENDPOINT_SLOTS = ["endpoint", "endpointA", "endpointB"] as const;

/** Loads the job's intake. With includeSecrets=false every apiKey is removed (use for anything agent-facing). */
export async function loadIntake(jobId: string, includeSecrets: boolean): Promise<IntakeInput> {
  const full = await getJobWithDecryptedCredentials(jobId);
  if (!full) throw new FatalError(`Job ${jobId} not found`);
  if (includeSecrets) return full.intake;
  const copy = { ...full.intake } as Record<string, unknown>;
  for (const slot of ENDPOINT_SLOTS) {
    const ep = copy[slot] as Record<string, unknown> | undefined;
    if (ep) {
      const { apiKey: _apiKey, ...rest } = ep;
      void _apiKey;
      copy[slot] = rest;
    }
  }
  return copy as IntakeInput;
}

import { and, desc, eq, inArray, lt, max, notInArray } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import {
  CRON_MILESTONES, FLAG_MILESTONE, PAID_NOT_RESUMED_MS, RECOVERY_MILESTONE, WORKING_STALE_MS, WORKING_STATES, BATCH_LIMIT,
  type StaleCandidate, type StaleJobDeps,
} from "../../../../server/stale-jobs";
import { alertOperators } from "../../../../server/operator-alerts";
import { jobRunLiveness, reenqueueJobRun, resumePaymentById } from "../../../../workflows/resume";
import { restartJobWorkflow } from "@/workflows/restart";

const SCAN_LIMIT = BATCH_LIMIT * 4;

/** Loads a bounded, oldest-first window of potentially stale jobs with the facts selectStale needs. */
export async function loadCandidates(now: number): Promise<StaleCandidate[]> {
  const cutoff = new Date(now - Math.min(WORKING_STALE_MS, PAID_NOT_RESUMED_MS));
  const jobs = await db().select({ id: schema.jobs.id, state: schema.jobs.state, updatedAt: schema.jobs.updatedAt }).from(schema.jobs)
    .where(and(inArray(schema.jobs.state, [...WORKING_STATES, "awaiting_payment"]), lt(schema.jobs.updatedAt, cutoff)))
    .orderBy(schema.jobs.updatedAt).limit(SCAN_LIMIT);
  if (jobs.length === 0) return [];
  const ids = jobs.map((j) => j.id);
  const [progress, cronEvents, payments] = await Promise.all([
    db().select({ jobId: schema.progressEvents.jobId, at: max(schema.progressEvents.createdAt) }).from(schema.progressEvents)
      .where(and(inArray(schema.progressEvents.jobId, ids), notInArray(schema.progressEvents.milestone, [...CRON_MILESTONES])))
      .groupBy(schema.progressEvents.jobId),
    db().select({ jobId: schema.progressEvents.jobId, milestone: schema.progressEvents.milestone, at: schema.progressEvents.createdAt })
      .from(schema.progressEvents)
      .where(and(inArray(schema.progressEvents.jobId, ids), inArray(schema.progressEvents.milestone, [FLAG_MILESTONE, RECOVERY_MILESTONE])))
      .orderBy(desc(schema.progressEvents.createdAt)),
    db().select({ id: schema.payments.id, jobId: schema.payments.jobId, createdAt: schema.payments.createdAt, resumedAt: schema.payments.workflowResumedAt })
      .from(schema.payments)
      .where(and(inArray(schema.payments.jobId, ids), eq(schema.payments.status, "paid"), eq(schema.payments.kind, "one_time"))),
  ]);
  return jobs.map((j) => {
    const mine = cronEvents.filter((e) => e.jobId === j.id);
    const unresumed = payments.filter((p) => p.jobId === j.id && !p.resumedAt).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    return {
      jobId: j.id, state: j.state, updatedAt: j.updatedAt,
      lastProgressAt: progress.find((p) => p.jobId === j.id)?.at ?? null,
      recoveryAt: mine.filter((e) => e.milestone === RECOVERY_MILESTONE).map((e) => e.at),
      escalatedAt: mine.find((e) => e.milestone === FLAG_MILESTONE)?.at ?? null,
      unresumedPayment: unresumed ? { id: unresumed.id, createdAt: unresumed.createdAt } : null,
      hasResumedPayment: payments.some((p) => p.jobId === j.id && p.resumedAt),
    };
  });
}

/** Escalation = operator-visible intervention + internal progress note (also the idempotency marker). Logged for alerting. */
async function escalate(jobId: string, note: string): Promise<void> {
  const [existing] = await db().select({ id: schema.interventions.id }).from(schema.interventions)
    .where(and(eq(schema.interventions.jobId, jobId), eq(schema.interventions.operatorEmail, "system@cron"), eq(schema.interventions.note, note))).limit(1);
  await db().insert(schema.progressEvents).values({ jobId, milestone: FLAG_MILESTONE, message: `Internal note: ${note}` });
  if (!existing) await db().insert(schema.interventions).values({ jobId, operatorEmail: "system@cron", kind: "other", note });
  console.error("stale-job escalated", jobId, note);
  await alertOperators({ kind: "stale_job", jobId, title: "Stale job escalated", detail: note, severity: "critical" });
}

async function recordAttempt(jobId: string, message: string): Promise<void> {
  await db().insert(schema.progressEvents).values({ jobId, milestone: RECOVERY_MILESTONE, message: `Internal note: ${message}` });
}

export const staleJobDeps: StaleJobDeps = {
  liveness: jobRunLiveness, reenqueue: reenqueueJobRun, resumePayment: resumePaymentById, recordAttempt, escalate,
  restart: restartJobWorkflow,
};

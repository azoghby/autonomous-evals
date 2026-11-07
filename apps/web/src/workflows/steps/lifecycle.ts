import { eq, and, isNull } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import type { JobState } from "@ae/core/contracts/index";
import { addMessage, recordProgress, setJobState } from "@/server/job-store";
import { deliveryDeadlines } from "../decisions";

/** States a customer/operator cancellation or terminal outcome must not be overwritten from. */
const TERMINAL: readonly JobState[] = ["cancelled", "failed", "delivered"];

export async function getStateStep(jobId: string): Promise<JobState> {
  "use step";
  const [row] = await db().select({ s: schema.jobs.state }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  return (row?.s ?? "failed") as JobState;
}

/** Moves the job forward unless it already reached a terminal state (e.g. cancelled by the customer meanwhile). */
export async function setStateStep(jobId: string, state: JobState, progress?: { milestone: string; message: string }): Promise<boolean> {
  "use step";
  const [row] = await db().select({ s: schema.jobs.state }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!row || TERMINAL.includes(row.s as JobState)) return false;
  await setJobState(jobId, state);
  if (progress) await recordProgress(jobId, progress.milestone, progress.message);
  return true;
}

export async function progressStep(jobId: string, milestone: string, message: string): Promise<void> {
  "use step";
  await recordProgress(jobId, milestone, message);
}

export async function commercialMessageStep(jobId: string, body: string): Promise<void> {
  "use step";
  await addMessage(jobId, "commercial", body);
}

export async function cancelStep(jobId: string, reason: string): Promise<void> {
  "use step";
  await setJobState(jobId, "cancelled");
  await recordProgress(jobId, "cancelled", `Job cancelled: ${reason}`);
  await releaseReservations(jobId);
}

export async function failStep(jobId: string, error: string): Promise<void> {
  "use step";
  await setJobState(jobId, "failed", { error: error.slice(0, 2000) });
  await recordProgress(jobId, "failed", "The job stopped because of an error. Our team has been notified.");
  await releaseReservations(jobId);
}

export async function pauseBudgetStep(jobId: string, message: string): Promise<void> {
  "use step";
  await setJobState(jobId, "paused_budget", { error: message.slice(0, 2000) });
  await recordProgress(jobId, "paused_budget", "Paused: the per-job compute budget was reached. An operator will review before anything continues.");
  await releaseReservations(jobId);
}

/** Declined / unresolvable requests end as cancelled with the reason visible to the customer. */
export async function declineStep(jobId: string, reason: string): Promise<void> {
  "use step";
  await addMessage(jobId, "commercial", reason);
  await setJobState(jobId, "cancelled", { error: reason.slice(0, 2000) });
  await recordProgress(jobId, "declined", "This request was not accepted.");
}

export async function deliverStep(jobId: string): Promise<{ deliveredAtIso: string }> {
  "use step";
  const d = deliveryDeadlines(new Date());
  await setJobState(jobId, "delivered", {
    deliveredAt: d.deliveredAt, credentialsDeleteAfter: d.credentialsDeleteAfter, branchDeleteAfter: d.branchDeleteAfter,
  });
  await recordProgress(jobId, "delivered", "Your report is ready.");
  return { deliveredAtIso: d.deliveredAt.toISOString() };
}

async function releaseReservations(jobId: string): Promise<void> {
  await db().update(schema.budgetReservations).set({ releasedAt: new Date() })
    .where(and(eq(schema.budgetReservations.jobId, jobId), isNull(schema.budgetReservations.releasedAt)));
}

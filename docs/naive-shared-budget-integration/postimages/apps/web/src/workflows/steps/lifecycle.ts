import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import type { JobState } from "@ae/core/contracts/index";
import { addMessage, recordProgress, setJobState } from "@/server/job-store";
import { alertOperators } from "@/server/operator-alerts";
import { deliveryDeadlines, sanitizeCheckDetail } from "../decisions";

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
  // Terminal job state does not prove outstanding provider work stopped; retain holds for reconciliation.
}

export async function failStep(jobId: string, error: string): Promise<void> {
  "use step";
  await setJobState(jobId, "failed", { error: error.slice(0, 2000) });
  await recordProgress(jobId, "failed", "The job stopped because of an error. Our team has been notified.");
  // Terminal job state does not prove outstanding provider work stopped; retain holds for reconciliation.
  await alertOperators({ kind: "job_failed", jobId, title: "Job failed", detail: `State: failed. ${error}`, severity: "critical" });
}

export async function pauseBudgetStep(jobId: string, message: string): Promise<void> {
  "use step";
  await setJobState(jobId, "paused_budget", { error: message.slice(0, 2000) });
  await recordProgress(jobId, "paused_budget", "Paused: the per-job compute budget was reached. An operator will review before anything continues.");
  // Terminal job state does not prove outstanding provider work stopped; retain holds for reconciliation.
  await alertOperators({ kind: "paused_budget", jobId, title: "Job paused on budget limit", detail: `State: paused_budget. ${message}`, severity: "warning" });
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

/**
 * Best-effort post-delivery Neon safety net: snapshot the branch and set a 7-day auto-delete TTL.
 * Never throws; failures become a progress note so delivery is unaffected.
 */
export async function neonDeliverySafetyStep(jobId: string, deliveredAtIso: string): Promise<void> {
  "use step";
  const notes: string[] = [];
  try {
    const { captureDeliverySnapshot } = await import("@ae/core/neon/delivery");
    await captureDeliverySnapshot(jobId);
  } catch (err) {
    notes.push(`snapshot skipped (${sanitizeCheckDetail(err instanceof Error ? err.message : String(err))})`);
  }
  try {
    const [row] = await db().select({ b: schema.jobs.neonBranchId }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
    if (row?.b) {
      const { applyBranchTtl } = await import("@ae/core/neon/ttl");
      await applyBranchTtl(row.b, new Date(deliveredAtIso));
    }
  } catch (err) {
    notes.push(`branch TTL not applied (${sanitizeCheckDetail(err instanceof Error ? err.message : String(err))})`);
  }
  if (notes.length) await recordProgress(jobId, "neon_safety_skipped", `Internal note: ${notes.join("; ")}.`).catch(() => undefined);
}

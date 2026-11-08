import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import type { JobState } from "@ae/core/contracts/index";
import { addMessage, finalizeJobCancellation, getJob, recordProgress, setJobStateIfActive } from "@/server/job-store";
import { getJobCancellation } from "@/server/job-cancellation";
import { alertOperators } from "@/server/operator-alerts";
import { deliveryDeadlines, sanitizeCheckDetail } from "../decisions";

export async function getStateStep(jobId: string): Promise<JobState> {
  "use step";
  const [row] = await db().select({ s: schema.jobs.state }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  return (row?.s ?? "failed") as JobState;
}

/** Moves the job forward unless it already reached a terminal state (e.g. cancelled by the customer meanwhile). */
export async function setStateStep(jobId: string, state: JobState, progress?: { milestone: string; message: string }): Promise<boolean> {
  "use step";
  const changed = await setJobStateIfActive(jobId, state, progress);
  if (!changed) {
    const request = await getJobCancellation(jobId);
    if (request) await finalizeJobCancellation(jobId, request.reason);
  }
  return changed;
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
  await finalizeJobCancellation(jobId, reason);
  // Outstanding provider work may still be running; retain every unknown hold for reconciliation.
}

/** Cancellation wins over late failure and budget outcomes. */
export async function failStep(jobId: string, error: string): Promise<"failed" | "cancelled"> {
  "use step";
  const request = await getJobCancellation(jobId);
  if (request) { await finalizeJobCancellation(jobId, request.reason); return "cancelled"; }
  const changed = await setJobStateIfActive(jobId, "failed", {
    milestone: "failed", message: "The job stopped because of an error. Our team has been notified.",
  }, { error: error.slice(0, 2000) });
  if (!changed) {
    const lateRequest = await getJobCancellation(jobId);
    if (lateRequest) { await finalizeJobCancellation(jobId, lateRequest.reason); return "cancelled"; }
    if ((await getJob(jobId))?.state === "cancelled") return "cancelled";
    return "failed";
  }
  // No outstanding provider hold is released by a terminal job transition.
  await alertOperators({ kind: "job_failed", jobId, title: "Job failed", detail: `State: failed. ${error}`, severity: "critical" });
  return "failed";
}

export async function pauseBudgetStep(jobId: string, message: string): Promise<void> {
  "use step";
  const request = await getJobCancellation(jobId);
  if (request) {
    await finalizeJobCancellation(jobId, request.reason);
    throw new Error("job_cancellation_requested");
  }
  const changed = await setJobStateIfActive(jobId, "paused_budget", {
    milestone: "paused_budget", message: "Paused: the per-job compute budget was reached. An operator will review before anything continues.",
  }, { error: message.slice(0, 2000) });
  if (!changed) {
    const lateRequest = await getJobCancellation(jobId);
    if (lateRequest) { await finalizeJobCancellation(jobId, lateRequest.reason); throw new Error("job_cancellation_requested"); }
    return;
  }
  // No outstanding provider hold is released by a pause.
  await alertOperators({ kind: "paused_budget", jobId, title: "Job paused on budget limit", detail: `State: paused_budget. ${message}`, severity: "warning" });
}

/** Declined / unresolvable requests end as cancelled with the reason visible to the customer. */
export async function declineStep(jobId: string, reason: string): Promise<void> {
  "use step";
  await addMessage(jobId, "commercial", reason);
  const changed = await setJobStateIfActive(jobId, "cancelled", { milestone: "declined", message: "This request was not accepted." }, { error: reason.slice(0, 2000) });
  if (!changed) {
    const request = await getJobCancellation(jobId);
    if (request) await finalizeJobCancellation(jobId, request.reason);
  }
}

export async function deliverStep(jobId: string): Promise<{ deliveredAtIso: string }> {
  "use step";
  const d = deliveryDeadlines(new Date());
  const changed = await setJobStateIfActive(jobId, "delivered", { milestone: "delivered", message: "Your report is ready." }, {
    deliveredAt: d.deliveredAt, credentialsDeleteAfter: d.credentialsDeleteAfter, branchDeleteAfter: d.branchDeleteAfter,
  });
  if (!changed) {
    const retained = await getJob(jobId);
    if (retained?.state === "delivered" && retained.deliveredAt) {
      return { deliveredAtIso: retained.deliveredAt.toISOString() };
    }
    throw new Error("job_cancellation_requested");
  }
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

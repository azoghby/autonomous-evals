import "server-only";
import { confirmAndResume, reconcile, type PaymentRow } from "@ae/core/payments/checkout";
import { eq } from "drizzle-orm";
import { getHookByToken, getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { reenqueueRun } from "@workflow/core/runtime";
import { db, schema } from "@ae/core/db/client";
import { jobHookToken } from "@ae/core/contracts/index";
import { sendJobEvent } from "./events";

/** Payment helpers bound to the workflow's event sender (core must not import the web app). */
export const resumeJobForPayment = (payment: PaymentRow) => confirmAndResume(payment, sendJobEvent);
export const reconcilePayments = () => reconcile(sendJobEvent);

export type RunLiveness = "alive" | "dead" | "unknown";

/** The job hook exists exactly while its run is active; a missing hook or a terminal run status means the run is dead. */
export async function jobRunLiveness(jobId: string): Promise<RunLiveness> {
  try {
    const hook = await getHookByToken(jobHookToken(jobId));
    const status = await getRun(hook.runId).status;
    return status === "pending" || status === "running" ? "alive" : "dead";
  } catch (err) {
    if (err instanceof Error && (err.name === "HookNotFoundError" || err.name === "WorkflowRunNotFoundError")) return "dead";
    console.error("jobRunLiveness failed", jobId, err instanceof Error ? err.message : err);
    return "unknown";
  }
}

/** Re-delivers the run's orchestrator message (recovers a dropped queue message). Safe to repeat: replay is deterministic, steps are durable. */
export async function reenqueueJobRun(jobId: string): Promise<void> {
  const hook = await getHookByToken(jobHookToken(jobId));
  await reenqueueRun(await getWorld(),hook.runId);
}

/** Replays one unresumed payment to its workflow (idempotent: duplicates are ignored by the workflow). */
export async function resumePaymentById(paymentId: string): Promise<void> {
  const [payment] = await db().select().from(schema.payments).where(eq(schema.payments.id, paymentId)).limit(1);
  if (payment) await resumeJobForPayment(payment);
}

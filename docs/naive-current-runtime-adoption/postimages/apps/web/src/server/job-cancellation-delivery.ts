import "server-only";
import { expireOpenCheckoutForCancellation } from "@ae/core/payments/checkout";
import { sendJobEvent } from "@/workflows/events";
import {
  getJobCancellation, listPendingCancellationJobs, markJobCancellationAttempt,
  markJobCancellationCheckoutDone, markJobCancellationDelivered,
} from "./job-cancellation";

export interface CancellationDelivery { jobId: string; errors: string[] }

/** At-least-once delivery: a crash after send but before acknowledgement can repeat a cancel event.
 * No external call is transactional. A failed send (including missing hook) stays pending; never restart
 * a job solely to notify it. Checkout expiry and Workflow notification retry independently.
 */
export async function dispatchJobCancellation(jobId: string): Promise<CancellationDelivery> {
  const request = await getJobCancellation(jobId);
  const errors: string[] = [];
  if (!request) return { jobId, errors };
  await markJobCancellationAttempt(jobId);
  if (!request.checkoutDone) {
    try {
      await expireOpenCheckoutForCancellation(jobId);
      await markJobCancellationCheckoutDone(jobId);
    } catch { errors.push("checkout_expiry_pending"); }
  }
  if (!request.eventDelivered) {
    try {
      await sendJobEvent(jobId, { type: "cancel", reason: request.reason });
      await markJobCancellationDelivered(jobId);
    } catch { errors.push("workflow_notification_pending"); }
  }
  return { jobId, errors };
}

/** Bounded oldest-first automatic retry, independent of job lifecycle state and stale-job age. */
export async function drainJobCancellations(limit = 25): Promise<{ attempted: number; errors: string[] }> {
  const jobs = await listPendingCancellationJobs(limit);
  const errors: string[] = [];
  for (const jobId of jobs) {
    try {
      const result = await dispatchJobCancellation(jobId);
      errors.push(...result.errors.map(error => `${jobId}:${error}`));
    } catch { errors.push(`${jobId}:cancellation_delivery_pending`); }
  }
  return { attempted: jobs.length, errors };
}

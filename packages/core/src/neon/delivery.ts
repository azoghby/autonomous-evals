import { eq } from "drizzle-orm";
import { db, schema } from "../db/client";
import { createNeonClient, NeonApiError, type NeonClient } from "./api";

export function deliverySnapshotName(jobId: string) {
  return `job-${jobId}-delivered`;
}

/**
 * Snapshot the job's simulator branch at delivery so the findings can be reproduced later.
 * Returns the snapshot id, or null when the job has no branch (or, see below, none could be taken).
 * Idempotent: if jobs.delivery_snapshot_id is already set it is returned unchanged.
 *
 * NOTE: Neon only permits snapshots of ROOT branches ("not allowed to snapshot non-root branch").
 * Job branches are children of sim-seed, so Neon answers 400; that case returns null (logged
 * without secrets) instead of failing delivery. Any other error is thrown.
 */
export async function captureDeliverySnapshot(jobId: string, client?: NeonClient): Promise<string | null> {
  const d = db();
  const [job] = await d.select({ branch: schema.jobs.neonBranchId, snap: schema.jobs.deliverySnapshotId })
    .from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job?.branch) return null;
  if (job.snap) return job.snap;

  try {
    const snapshot = await (client ?? createNeonClient()).createSnapshot(job.branch, deliverySnapshotName(jobId));
    await d.update(schema.jobs).set({ deliverySnapshotId: snapshot.id, updatedAt: new Date() }).where(eq(schema.jobs.id, jobId));
    return snapshot.id;
  } catch (e) {
    if (e instanceof NeonApiError && e.status === 400 && /non-root/i.test(e.message)) {
      console.warn(`captureDeliverySnapshot: job ${jobId} branch is not a root branch; no snapshot taken`);
      return null;
    }
    throw e;
  }
}

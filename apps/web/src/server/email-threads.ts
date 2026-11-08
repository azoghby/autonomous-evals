import "server-only";
import { db, schema } from "@ae/core/db/client";

/** Records which job / engagement an outbound thread belongs to so replies can be routed. Best-effort. */
export async function recordEmailThread(
  threadId: string | null | undefined, purpose: string, ref: { jobId?: string; expertEngagementId?: string },
): Promise<void> {
  if (!threadId) return;
  try {
    await db().insert(schema.emailThreads).values({
      threadId, purpose, jobId: ref.jobId ?? null, expertEngagementId: ref.expertEngagementId ?? null,
    }).onConflictDoNothing();
  } catch (err) {
    console.error("recordEmailThread failed", err instanceof Error ? err.message : err);
  }
}

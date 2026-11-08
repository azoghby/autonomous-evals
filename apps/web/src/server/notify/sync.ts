import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";

/**
 * When something is decided outside the phone flow (e.g. the operator clicks Approve in /operator/outreach),
 * close the matching pending founder approval so the phone buttons become no-ops. Best effort, never throws.
 * Kept dependency-light so domain modules can import it without cycles.
 */
export async function closeApprovalFromSource(kind: string, ref: string, status: "approved" | "rejected", actor: string, now = new Date()): Promise<void> {
  try {
    const t = schema.founderApprovals;
    await db().update(t)
      .set({ status, decidedVia: "console", decidedBy: actor, decidedAt: now, result: `Decided in the operator console (${status}).` })
      .where(and(eq(t.kind, kind), eq(t.ref, ref), eq(t.status, "pending")));
  } catch (err) {
    console.error("closeApprovalFromSource failed", kind, err instanceof Error ? err.message : err);
  }
}

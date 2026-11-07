import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { decryptJson } from "@ae/core/storage/crypto";
import { jsonError } from "@/server/http";
import { getJobForViewer, getCurrentCustomer } from "@/server/queries";
import { getJob } from "@/server/job-store";
import { withIdempotency, IdempotencyInProgressError } from "@/server/idempotency";
import { createJob } from "@/server/create-job";
import { credentialSlotsOf, type CredentialMap } from "@/server/intake";

export async function POST(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  const { jobId } = await ctx.params;
  if (!(await getJobForViewer(jobId, me))) return jsonError(404, "Job not found");
  const key = req.headers.get("idempotency-key")?.trim();
  if (!key || key.length > 200) return jsonError(400, "Idempotency-Key header is required (max 200 chars)");
  const src = await getJob(jobId);
  if (!src) return jsonError(404, "Job not found");

  try {
    const out = await withIdempotency(`${me.id}:jobs.retest:${jobId}:${key}`, async () => {
      const [credRow] = await db().select().from(schema.jobCredentials).where(eq(schema.jobCredentials.jobId, jobId)).limit(1);
      const stored = src.intake as Record<string, unknown>;
      if (credentialSlotsOf(stored).length > 0 && !credRow) {
        return { status: 409, body: { error: "Credentials were deleted after delivery; please resubmit your request with fresh keys." } };
      }
      // Re-encrypted copy (fresh IV) so deleting one job's credentials never affects the other.
      const credentials = credRow ? decryptJson<CredentialMap>(credRow.ciphertext) : {};
      const { jobId: newId } = await createJob({
        customerId: src.customerId, idempotencyKey: `retest:${key}`, retestOfJobId: jobId,
        prepared: { sanitized: stored, credentials, traceBlobPath: src.traceBlobPath },
      });
      return { status: 201, body: { jobId: newId } };
    });
    return Response.json(out.body, { status: out.status });
  } catch (err) {
    if (err instanceof IdempotencyInProgressError) return jsonError(409, err.message);
    console.error("retest failed", err);
    return jsonError(500, "Could not create retest");
  }
}

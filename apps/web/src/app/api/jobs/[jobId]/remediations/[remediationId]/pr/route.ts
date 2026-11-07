import { isUuid, jsonError } from "@/server/http";
import { withIdempotency, IdempotencyInProgressError } from "@/server/idempotency";
import { rateLimit } from "@/server/rate-limit";
import { authorizeOwner, openRemediationPr } from "@/server/github-service";

export const dynamic = "force-dynamic";

/** Opens (or returns the existing) pull request for one verified remediation. Owner only. */
export async function POST(req: Request, ctx: { params: Promise<{ jobId: string; remediationId: string }> }) {
  const { jobId, remediationId } = await ctx.params;
  const a = await authorizeOwner(jobId);
  if (a.res) return a.res;
  if (!isUuid(remediationId)) return jsonError(404, "Remediation not found");
  const key = req.headers.get("idempotency-key")?.trim();
  if (!key || key.length > 200) return jsonError(400, "Idempotency-Key header is required (max 200 chars)");
  const rl = await rateLimit(`github-pr:${a.me.id}`, 10, 600);
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });

  const origin = new URL(req.url).origin;
  try {
    const out = await withIdempotency(`${a.me.id}:jobs.github-pr:${remediationId}:${key}`, () => openRemediationPr(a.job.id, remediationId, origin));
    return Response.json(out.body, { status: out.status });
  } catch (err) {
    if (err instanceof IdempotencyInProgressError) return jsonError(409, err.message);
    return jsonError(500, "Could not open the pull request");
  }
}

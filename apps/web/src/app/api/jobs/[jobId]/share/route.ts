import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { jsonError, readJson, requireViewer, isUuid } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { enableShare, revokeShare, getShareStatus } from "@/server/share";
import { shareUrls } from "@/server/share-core";

export const dynamic = "force-dynamic";
const Body = z.object({ enabled: z.boolean() });
const noStore = { "Cache-Control": "no-store" };

async function ownedJob(jobId: string, viewerId: string) {
  if (!isUuid(jobId)) return null;
  const [job] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  return job && job.customerId === viewerId ? job : null;
}

const baseUrl = (req: Request) => process.env.APP_URL ?? new URL(req.url).origin;

/** Owner only: is a share link active? (The token itself is never retrievable.) */
export async function GET(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const { jobId } = await ctx.params;
  if (!(await ownedJob(jobId, auth.viewer.id))) return jsonError(404, "Job not found");
  return Response.json(await getShareStatus(jobId), { headers: noStore });
}

/** Owner only. enabled:true creates (or rotates) the link and returns the token once; enabled:false revokes. */
export async function POST(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const rl = await rateLimit(`share:${auth.viewer.id}`, 20, 600);
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  const { jobId } = await ctx.params;
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  const job = await ownedJob(jobId, auth.viewer.id);
  if (!job) return jsonError(404, "Job not found");

  if (!body.data.enabled) {
    await revokeShare(jobId);
    return Response.json({ enabled: false }, { headers: noStore });
  }
  if (job.state !== "delivered") return jsonError(409, "Only delivered jobs can be shared", { state: job.state });
  const { token, createdAt } = await enableShare(jobId);
  return Response.json({ enabled: true, token, createdAt, ...shareUrls(baseUrl(req), token) }, { status: 201, headers: noStore });
}

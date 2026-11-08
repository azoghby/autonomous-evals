import { jsonError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { getJobForViewer, getCurrentCustomer } from "@/server/queries";
import { rerunFindingForJob } from "@/server/job-actions";

export async function POST(_req: Request, ctx: { params: Promise<{ jobId: string; findingId: string }> }) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  const rl = await rateLimit(`finding-rerun:${me.id}`, 20, 3600);
  if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  const { jobId, findingId } = await ctx.params;
  const data = await getJobForViewer(jobId, me);
  if (!data) return jsonError(404, "Job not found");
  const r = await rerunFindingForJob(data, findingId);
  if (!r.ok) return jsonError(r.status, r.error, r.extra);
  return Response.json(r.value, { status: 201 });
}

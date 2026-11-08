import { jsonError } from "@/server/http";
import { getJobForViewer, getCurrentCustomer } from "@/server/queries";
import { rerunFindingForJob } from "@/server/job-actions";

export async function POST(req: Request, ctx: { params: Promise<{ jobId: string; findingId: string }> }) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  const { jobId, findingId } = await ctx.params;
  const data = await getJobForViewer(jobId, me);
  if (!data) return jsonError(404, "Job not found");
  const r = await rerunFindingForJob(data, findingId, req.headers.get("Idempotency-Key") ?? undefined, me.id);
  if (!r.ok) return jsonError(r.status, r.error, r.extra);
  return Response.json(r.value, { status: (r.value as {state:string}).state === "completed" ? 200 : 202 });
}

/** Separate private appendices; original report and finding rows remain immutable. */
export async function GET(_req: Request, ctx: { params: Promise<{jobId:string;findingId:string}> }) {
 const me=await getCurrentCustomer(); if(!me) return jsonError(401,'Authentication required');
 const {jobId,findingId}=await ctx.params; const data=await getJobForViewer(jobId,me);
 if(!data || data.job.customerId!==me.id) return jsonError(404,'Job not found');
 const {readRichRerunsForOwner}=await import('@/server/rich-rerun');
 return Response.json({reruns:await readRichRerunsForOwner(jobId,me.id,findingId)});
}

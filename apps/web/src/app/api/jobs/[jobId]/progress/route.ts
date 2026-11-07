import { jsonError } from "@/server/http";
import { getJobForViewer, getCurrentCustomer } from "@/server/queries";

export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  const { jobId } = await ctx.params;
  const data = await getJobForViewer(jobId, me);
  if (!data) return jsonError(404, "Job not found");
  return Response.json({
    state: data.job.state,
    error: data.job.error,
    progress: data.progress.map((p) => ({ milestone: p.milestone, message: p.message, createdAt: p.createdAt })),
    updatedAt: data.job.updatedAt,
  }, { headers: { "Cache-Control": "no-store" } });
}

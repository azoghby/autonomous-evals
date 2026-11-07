import { jsonError } from "@/server/http";
import { getJobForViewer, getCurrentCustomer } from "@/server/queries";

export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  const { jobId } = await ctx.params;
  const data = await getJobForViewer(jobId, me);
  return data ? Response.json(data) : jsonError(404, "Job not found");
}

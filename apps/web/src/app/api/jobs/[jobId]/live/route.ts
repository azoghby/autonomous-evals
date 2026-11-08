import { jsonError } from "@/server/http";
import { canViewJob } from "@/server/access";
import { getJob } from "@/server/job-store";
import { getCurrentCustomer } from "@/server/session";
import { realtimeConfigured, realtimeUrl, sealJobLive } from "@/server/realtime";

/**
 * Mints sealed live queries for ONE job. Same ownership rule as every job read (TRACK_A_PLAN decision 8):
 * owner or operator, otherwise 404. The browser can only subscribe to the two fixed queries sealed here.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  const { jobId } = await ctx.params;
  const job = /^[0-9a-f-]{36}$/i.test(jobId) ? await getJob(jobId) : null;
  if (!job || !canViewJob(me, job)) return jsonError(404, "Job not found"); // missing and foreign look identical
  if (!realtimeConfigured()) return jsonError(503, "Realtime not configured");
  const sealed = await sealJobLive(job.id, me.isOperator);
  return Response.json({ url: realtimeUrl(), ...sealed }, { headers: { "Cache-Control": "private, no-store" } });
}

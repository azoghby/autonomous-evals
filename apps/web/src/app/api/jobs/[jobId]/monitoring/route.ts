import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { createMonitoringCheckout } from "@ae/core/payments/checkout";
import { jsonError, isUuid } from "@/server/http";
import { getCurrentCustomer } from "@/server/queries";

export const dynamic = "force-dynamic";

/** Starts a $49/month monitoring subscription checkout for a delivered job. Owner only. */
export async function POST(request: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  const { jobId } = await ctx.params;
  if (!isUuid(jobId)) return jsonError(404, "Job not found");
  const [job] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job || job.customerId !== me.id) return jsonError(404, "Job not found");
  if (job.state !== "delivered") return jsonError(409, "Monitoring can be added once the report is delivered");
  const origin = (process.env.APP_URL ?? new URL(request.url).origin).replace(/\/$/, "");
  try {
    const { url } = await createMonitoringCheckout(jobId, {
      customerEmail: me.email, successUrl: `${origin}/jobs/${jobId}?monitoring=success`, cancelUrl: `${origin}/jobs/${jobId}`,
    });
    return Response.json({ checkoutUrl: url });
  } catch (err) {
    console.error("monitoring checkout failed", jobId, err instanceof Error ? err.message : err);
    return jsonError(502, "Could not start checkout. Please try again.");
  }
}

import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import type { JobState } from "@ae/core/contracts/index";
import { jsonError, readJson, isUuid } from "@/server/http";
import { getCurrentCustomer } from "@/server/queries";
import { addMessage } from "@/server/job-store";
import { expireOpenCheckout } from "@ae/core/payments/checkout";
import { sendJobEvent } from "@/workflows/events";
import { decideCancel } from "@/workflows/decisions";

export const dynamic = "force-dynamic";
const Body = z.object({ reason: z.string().trim().max(1_000).optional() });

/** Owner: only before planning. Operator: any non-terminal job (recorded as an intervention). */
export async function POST(request: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  const { jobId } = await ctx.params;
  if (!isUuid(jobId)) return jsonError(404, "Job not found");
  const body = await readJson(request, Body);
  if (!body.ok) return body.res;

  const [job] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) return jsonError(404, "Job not found");
  const decision = decideCancel({ customerId: job.customerId, state: job.state as JobState }, me);
  if (!decision.allowed) return jsonError(decision.status, decision.error, decision.status === 409 ? { state: job.state } : undefined);

  const reason = body.data.reason || (decision.asOperator ? "Cancelled by an operator" : "Cancelled by the customer");
  if (decision.asOperator) {
    await db().insert(schema.interventions).values({ jobId, operatorEmail: me.email, kind: "other", note: `Cancelled job: ${reason}` });
  }
  await addMessage(jobId, decision.asOperator ? "operator" : "customer", `Cancellation requested: ${reason}`);
  // Close the open Checkout session so a cancelled job cannot still be paid (best effort; late payments are handled on arrival).
  try { await expireOpenCheckout(jobId); } catch (err) {
    console.error("cancel expireOpenCheckout failed", jobId, err instanceof Error ? err.message : err);
  }
  try {
    await sendJobEvent(jobId, { type: "cancel", reason });
  } catch (err) {
    console.error("cancel sendJobEvent failed", jobId, err instanceof Error ? err.message : err);
    return jsonError(502, "Cancellation recorded but the job could not be notified; please retry");
  }
  return Response.json({ ok: true }, { status: 202 });
}

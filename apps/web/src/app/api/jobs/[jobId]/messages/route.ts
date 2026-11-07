import { z } from "zod";
import { jsonError, readJson } from "@/server/http";
import { getJobForViewer, getCurrentCustomer } from "@/server/queries";
import { addMessage } from "@/server/job-store";
import { sendJobEvent } from "@/workflows/events";

const Body = z.object({ answer: z.string().trim().min(1).max(10_000) });

export async function POST(req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  const { jobId } = await ctx.params;
  const data = await getJobForViewer(jobId, me);
  if (!data) return jsonError(404, "Job not found");
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  if (data.job.state !== "needs_clarification") return jsonError(409, "Job is not waiting for a clarification answer", { state: data.job.state });
  const messageId = await addMessage(jobId, "customer", body.data.answer);
  try {
    await sendJobEvent(jobId, { type: "clarification_answer", answer: body.data.answer });
  } catch (err) {
    console.error("sendJobEvent failed", err);
    return jsonError(502, "Answer saved but the job could not be notified; please retry", { messageId });
  }
  return Response.json({ ok: true, messageId }, { status: 201 });
}

import "server-only";
import type { getJobForViewer } from "./queries";
import { addMessage } from "./job-store";
import { sendJobEvent } from "@/workflows/events";

type JobData = NonNullable<Awaited<ReturnType<typeof getJobForViewer>>>;
export type ActionResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; extra?: Record<string, unknown> };


/** Shared by the messages route and the MCP answer_clarification tool. Caller has already authorized `data`. */
export async function submitClarificationAnswer(data: JobData, answer: string): Promise<ActionResult<{ messageId: string }>> {
  const jobId = data.job.id;
  if (data.job.state !== "needs_clarification") {
    return { ok: false, status: 409, error: "Job is not waiting for a clarification answer", extra: { state: data.job.state } };
  }
  const messageId = await addMessage(jobId, "customer", answer);
  try {
    await sendJobEvent(jobId, { type: "clarification_answer", answer });
  } catch (err) {
    console.error("sendJobEvent failed", err);
    return { ok: false, status: 502, error: "Answer saved but the job could not be notified; please retry", extra: { messageId } };
  }
  return { ok: true, value: { messageId } };
}

/** Both authenticated transports use the same durable rich service. */
export async function rerunFindingForJob(data: JobData, findingId: string, key?: string, ownerId?: string): Promise<ActionResult<unknown>> {
 if (!key || !ownerId) return {ok:false,status:400,error:'Idempotency-Key and authenticated owner required'};
 try { const {rerunRichFinding,RerunRefusal}=await import('./rich-rerun');
  try { return {ok:true,value:await rerunRichFinding({jobId:data.job.id,findingId,key,ownerId})}; }
  catch(error){ if(error instanceof RerunRefusal) return {ok:false,status:error.status,error:error.message}; throw error; }
 } catch { return {ok:false,status:409,error:'Re-run unavailable; operator reconciliation required'}; }
}

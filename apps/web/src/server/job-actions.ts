import "server-only";
import { and, count, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { Finding, Suite, type Scenario } from "@ae/core/contracts/index";
import { readJobArtifactText } from "@ae/core/storage/blob";
import { isUuid } from "./http";
import type { getJobForViewer } from "./queries";
import { addMessage, getJob, makeServiceContext, saveFindings } from "./job-store";
import { getEvalServices } from "./services";
import { sendJobEvent } from "@/workflows/events";

type JobData = NonNullable<Awaited<ReturnType<typeof getJobForViewer>>>;
export type ActionResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; extra?: Record<string, unknown> };

const MAX_RERUNS_PER_FINDING = 3;

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

/** Shared by the rerun route and the MCP rerun_finding tool. Caller has already authorized `data`. */
export async function rerunFindingForJob(data: JobData, findingId: string): Promise<ActionResult<{ finding: unknown }>> {
  const jobId = data.job.id;
  if (!isUuid(findingId)) return { ok: false, status: 404, error: "Finding not found" };
  const row = data.findings.find((f) => f.id === findingId);
  if (!row) return { ok: false, status: 404, error: "Finding not found" };
  if (data.job.state !== "delivered") {
    return { ok: false, status: 409, error: "Findings can be re-run once the job is delivered", extra: { state: data.job.state } };
  }
  const parsed = Finding.safeParse(row.data);
  if (!parsed.success) return { ok: false, status: 409, error: "Stored finding is not re-runnable" };
  const originalId = row.rerunOfFindingId ?? row.id;
  const [{ n }] = await db().select({ n: count() }).from(schema.findings)
    .where(and(eq(schema.findings.jobId, jobId), eq(schema.findings.rerunOfFindingId, originalId)));
  if (n >= MAX_RERUNS_PER_FINDING) return { ok: false, status: 409, error: "Re-run limit reached for this finding" };

  let scenario: Scenario | undefined;
  const job = await getJob(jobId);
  if (job?.suiteBlobPath && parsed.data.scenarioId) {
    const raw = await readJobArtifactText(job.suiteBlobPath);
    const suite = raw ? Suite.safeParse(JSON.parse(raw)) : null;
    scenario = suite?.success ? suite.data.scenarios.find((s) => s.id === parsed.data.scenarioId) : undefined;
  }
  try {
    const sctx = await makeServiceContext(jobId);
    await sctx.recordProgress("finding_rerun", `Re-running finding "${parsed.data.title}"`);
    const rerun = Finding.parse(await (await getEvalServices()).rerunFinding(sctx, parsed.data, scenario));
    await saveFindings(jobId, [rerun], originalId);
    const [saved] = await db().select().from(schema.findings)
      .where(and(eq(schema.findings.jobId, jobId), eq(schema.findings.rerunOfFindingId, originalId)))
      .orderBy(schema.findings.createdAt).then((r) => r.slice(-1));
    return { ok: true, value: { finding: saved } };
  } catch (err) {
    console.error("rerun failed", err);
    return { ok: false, status: 502, error: "Re-run failed" };
  }
}

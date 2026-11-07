import { and, eq, count } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { Finding, Suite, type Scenario } from "@ae/core/contracts/index";
import { readJobArtifactText } from "@ae/core/storage/blob";
import { jsonError, isUuid } from "@/server/http";
import { getJobForViewer, getCurrentCustomer } from "@/server/queries";
import { getJob, makeServiceContext, saveFindings } from "@/server/job-store";
import { getEvalServices } from "@/server/services";

const MAX_RERUNS_PER_FINDING = 3;

export async function POST(_req: Request, ctx: { params: Promise<{ jobId: string; findingId: string }> }) {
  const me = await getCurrentCustomer();
  if (!me) return jsonError(401, "Authentication required");
  const { jobId, findingId } = await ctx.params;
  const data = await getJobForViewer(jobId, me);
  if (!data) return jsonError(404, "Job not found");
  if (!isUuid(findingId)) return jsonError(404, "Finding not found");
  const row = data.findings.find((f) => f.id === findingId);
  if (!row) return jsonError(404, "Finding not found");
  if (data.job.state !== "delivered") return jsonError(409, "Findings can be re-run once the job is delivered", { state: data.job.state });

  const parsed = Finding.safeParse(row.data);
  if (!parsed.success) return jsonError(409, "Stored finding is not re-runnable");
  const originalId = row.rerunOfFindingId ?? row.id;
  const [{ n }] = await db().select({ n: count() }).from(schema.findings)
    .where(and(eq(schema.findings.jobId, jobId), eq(schema.findings.rerunOfFindingId, originalId)));
  if (n >= MAX_RERUNS_PER_FINDING) return jsonError(409, "Re-run limit reached for this finding");

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
    return Response.json({ finding: saved }, { status: 201 });
  } catch (err) {
    console.error("rerun failed", err);
    return jsonError(502, "Re-run failed");
  }
}

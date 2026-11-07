import { desc, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import type { QualifyResult } from "@ae/core/contracts/index";
import { createQuote, makeServiceContext, recordProgress, setJobState } from "@/server/job-store";
import { sanitizeCheckDetail, type EndpointCheckFailure } from "../decisions";
import { loadIntake, requireJob, withBudget, type BudgetResult } from "./common";
import { getEvalServices } from "@/server/services";

export async function qualifyStep(jobId: string, clarifications: string[]): Promise<BudgetResult<QualifyResult>> {
  "use step";
  const intake = await loadIntake(jobId, false);
  const services = await getEvalServices();
  const result = await withBudget(jobId, "commercial", (ctx) => services.qualify(ctx, intake, clarifications));
  if (result.status === "ok") {
    await recordProgress(jobId, "qualified", `Request reviewed (${result.data.decision}).`);
    // The job's package was fixed at intake; the quote must match what the pipeline will run.
    const job = await requireJob(jobId);
    return { status: "ok", data: { ...result.data, package: job.package } };
  }
  return result;
}
qualifyStep.maxRetries = 1;

/** Creates the quote (price from the fixed table), idempotently: a retry reuses an identical unaccepted latest quote. */
export async function createQuoteStep(jobId: string, qualify: QualifyResult): Promise<{ version: number; priceCents: number }> {
  "use step";
  const [latest] = await db().select().from(schema.quotes).where(eq(schema.quotes.jobId, jobId))
    .orderBy(desc(schema.quotes.version)).limit(1);
  let version: number, priceCents: number;
  if (latest && latest.scopeSummary === qualify.scopeSummary && latest.package === qualify.package && !latest.acceptedAt) {
    ({ version, priceCents } = latest);
  } else {
    const q = await createQuote(jobId, qualify);
    ({ version, priceCents } = q);
  }
  await setJobState(jobId, "quoted");
  await recordProgress(jobId, "quoted", `Quote v${version} ready: $${(priceCents / 100).toFixed(2)}.`);
  return { version, priceCents };
}

/** Pre-payment connectivity check of the customer's endpoint(s). Credentials are decrypted only inside this step. */
export async function connectionCheckStep(jobId: string): Promise<{ ok: true } | { ok: false; failures: EndpointCheckFailure[] }> {
  "use step";
  const intake = await loadIntake(jobId, true);
  const services = await getEvalServices();
  const ctx = await makeServiceContext(jobId);
  const slots = [["endpoint", "Your endpoint"], ["endpointA", "Endpoint A"], ["endpointB", "Endpoint B"]] as const;
  const failures: EndpointCheckFailure[] = [];
  for (const [slot, label] of slots) {
    const ep = (intake as Record<string, unknown>)[slot] as { url: string; model: string; apiKey?: string } | undefined;
    if (!ep) continue;
    let res: { ok: boolean; detail: string };
    try {
      res = await services.checkTarget(ctx, { url: ep.url, model: ep.model, apiKey: ep.apiKey });
    } catch (err) {
      res = { ok: false, detail: err instanceof Error ? err.message : "connection failed" };
    }
    if (!res.ok) failures.push({ label, detail: sanitizeCheckDetail(res.detail, ep.apiKey ? [ep.apiKey] : []) });
  }
  if (failures.length) {
    await recordProgress(jobId, "connection_check_failed", "We could not connect to your endpoint.");
    return { ok: false, failures };
  }
  await recordProgress(jobId, "connection_check_passed", "Endpoint connection verified.");
  return { ok: true };
}

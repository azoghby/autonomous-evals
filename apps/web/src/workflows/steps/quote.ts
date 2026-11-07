import { desc, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import type { QualifyResult } from "@ae/core/contracts/index";
import { createQuote, recordProgress, setJobState } from "@/server/job-store";
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

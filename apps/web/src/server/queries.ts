import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { readJobArtifactText } from "@ae/core/storage/blob";
import { canViewJob, type Viewer } from "./access";
import { getCurrentCustomer } from "./session";
import type { Remediation } from "@ae/core/contracts/index";
import { getJob, type JobRow } from "./job-store";
import { summarizeIntake, type IntakeSummary } from "./intake";
import { publicJobError } from "./public-error";

export { getCurrentCustomer };

type Job = typeof schema.jobs.$inferSelect;
/** Job without anything sensitive: the raw intake (incl. traces) is replaced by a summary. */
export type PublicJob = Omit<Job, "idempotencyKey" | "workflowRunId" | "neonBranchId" | "intake"> & { intakeSummary: IntakeSummary };

/** `error` is redacted to a generic message unless `isOperator` is explicitly true. */
export function toPublicJob(job: Job, isOperator = false): PublicJob {
  const { idempotencyKey: _i, workflowRunId: _w, neonBranchId: _n, intake, ...rest } = job;
  void _i; void _w; void _n;
  return { ...rest, error: publicJobError(job.error, isOperator), intakeSummary: summarizeIntake(intake, job.package, job.traceBlobPath) };
}

export async function listMyJobs() {
  const me = await getCurrentCustomer();
  if (!me) return null;
  const rows = await db().select().from(schema.jobs)
    .where(me.isOperator ? sql`true` : eq(schema.jobs.customerId, me.id)).orderBy(desc(schema.jobs.createdAt)).limit(100);
  return rows.map((j) => toPublicJob(j, me.isOperator));
}

export interface JobReport { summary: string; markdown: string }

async function loadReport(job: JobRow): Promise<JobReport | undefined> {
  if (!job.reportBlobPath) return undefined;
  try {
    const raw = await readJobArtifactText(job.reportBlobPath);
    if (raw === null) return undefined;
    try {
      const parsed = JSON.parse(raw) as { summary?: unknown; markdown?: unknown };
      if (typeof parsed.markdown === "string") {
        return { summary: typeof parsed.summary === "string" ? parsed.summary : "", markdown: parsed.markdown };
      }
    } catch { /* plain markdown */ }
    return { summary: "", markdown: raw };
  } catch {
    return undefined;
  }
}

/** Server-side ownership check. Returns null for missing AND unauthorized (no existence leak). */
export async function getJobForViewer(jobId: string, viewer?: Viewer | null) {
  const me = viewer === undefined ? await getCurrentCustomer() : viewer;
  if (!me || !/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const job = await getJob(jobId);
  if (!job || !canViewJob(me, job)) return null;
  const [quotes, messages, progress, findings, payments, remediationRows, report] = await Promise.all([
    db().select().from(schema.quotes).where(eq(schema.quotes.jobId, jobId)).orderBy(asc(schema.quotes.version)),
    db().select().from(schema.messages).where(eq(schema.messages.jobId, jobId)).orderBy(asc(schema.messages.createdAt)),
    db().select().from(schema.progressEvents).where(eq(schema.progressEvents.jobId, jobId)).orderBy(asc(schema.progressEvents.createdAt)),
    db().select().from(schema.findings).where(eq(schema.findings.jobId, jobId)).orderBy(asc(schema.findings.createdAt)),
    db().select().from(schema.payments).where(eq(schema.payments.jobId, jobId)).orderBy(asc(schema.payments.createdAt)),
    db().select().from(schema.remediations).where(eq(schema.remediations.jobId, jobId)).orderBy(asc(schema.remediations.createdAt)),
    loadReport(job),
  ]);
  const remediations = remediationRows.map((r) => ({ id: r.id, findingRowId: r.findingRowId, createdAt: r.createdAt, ...(r.data as Remediation) }));
  return {
    job: toPublicJob(job, me.isOperator), quotes, messages, progress, findings, payments, remediations,
    ...(report ? { report } : {}),
  };
}

/** Per-row recognised revenue: captured amount for settled per-finding payments, 0 while held/released, amount otherwise. */
export const REVENUE_CENTS_SQL = sql`case ${schema.payments.status}
  when 'captured' then coalesce(${schema.payments.capturedAmountCents}, 0)
  when 'authorized' then 0 when 'released' then 0
  else ${schema.payments.amountCents} end`;

export async function getOperatorOverview() {
  const me = await getCurrentCustomer();
  if (!me?.isOperator) return null;
  const d = db();
  const [jobs, payments, sessions, interventions, outreach, perJobCost, totals, bySource, emailRows] = await Promise.all([
    d.select().from(schema.jobs).orderBy(desc(schema.jobs.createdAt)).limit(200),
    d.select().from(schema.payments).orderBy(desc(schema.payments.createdAt)).limit(200),
    d.select({
      id: schema.agentSessions.id, jobId: schema.agentSessions.jobId, agent: schema.agentSessions.agent,
      status: schema.agentSessions.status, decision: schema.agentSessions.decision,
      usageMicroUsd: schema.agentSessions.usageMicroUsd, createdAt: schema.agentSessions.createdAt,
    }).from(schema.agentSessions).orderBy(desc(schema.agentSessions.createdAt)).limit(200),
    d.select().from(schema.interventions).orderBy(desc(schema.interventions.createdAt)).limit(200),
    d.select().from(schema.outreachDrafts).orderBy(desc(schema.outreachDrafts.createdAt)).limit(200),
    d.select({ jobId: schema.costs.jobId, microUsd: sql<number>`sum(${schema.costs.microUsd})::bigint` })
      .from(schema.costs).groupBy(schema.costs.jobId),
    Promise.all([
      // Revenue = money actually taken: paid fixed payments + captured per-finding amounts (never the authorized cap).
      d.select({ s: sql<number>`coalesce(sum(${REVENUE_CENTS_SQL}), 0)::bigint` }).from(schema.payments)
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.payments.jobId))
        .where(and(eq(schema.payments.environment, "live"), eq(schema.jobs.isMock, false))),
      d.select({ s: sql<number>`coalesce(sum(${schema.costs.microUsd}), 0)::bigint` }).from(schema.costs),
    ]),
    d.select({ source: schema.costs.source, microUsd: sql<number>`sum(${schema.costs.microUsd})::bigint` })
      .from(schema.costs).groupBy(schema.costs.source),
    d.select({ id: schema.customers.id, email: schema.customers.email }).from(schema.customers),
  ]);
  const emailById = new Map(emailRows.map((c) => [c.id, c.email]));
  const knownCostBySourceMicroUsd: Record<string, number> = {};
  for (const r of bySource) knownCostBySourceMicroUsd[r.source] = Number(r.microUsd);
  const costByJob: Record<string, number> = {};
  for (const r of perJobCost) if (r.jobId) costByJob[r.jobId] = Number(r.microUsd);
  return {
    liveRevenueCents: Number(totals[0][0]?.s ?? 0),
    knownCostMicroUsd: Number(totals[1][0]?.s ?? 0),
    knownCostBySourceMicroUsd,
    costByJobMicroUsd: costByJob,
    jobs: jobs.map((j) => ({ ...toPublicJob(j, true), knownCostMicroUsd: costByJob[j.id] ?? 0, customerEmail: emailById.get(j.customerId) })),
    payments, agentSessions: sessions, interventions, outreachDrafts: outreach,
  };
}

import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { readJobArtifactText } from "@ae/core/storage/blob";
import { canViewJob, type Viewer } from "./access";
import { getCurrentCustomer } from "./session";
import { getJob, type JobRow } from "./job-store";

export { getCurrentCustomer };

type Job = typeof schema.jobs.$inferSelect;
/** Job without anything sensitive. (Credentials are in a separate table; intake is already stripped.) */
export type PublicJob = Omit<Job, "idempotencyKey" | "workflowRunId" | "neonBranchId"> ;

export function toPublicJob(job: Job): PublicJob {
  const { idempotencyKey: _i, workflowRunId: _w, neonBranchId: _n, ...rest } = job;
  void _i; void _w; void _n;
  return rest;
}

export async function listMyJobs() {
  const me = await getCurrentCustomer();
  if (!me) return null;
  const rows = await db().select().from(schema.jobs)
    .where(me.isOperator ? sql`true` : eq(schema.jobs.customerId, me.id)).orderBy(desc(schema.jobs.createdAt)).limit(100);
  return rows.map(toPublicJob);
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
  const [quotes, messages, progress, findings, payments, report] = await Promise.all([
    db().select().from(schema.quotes).where(eq(schema.quotes.jobId, jobId)).orderBy(asc(schema.quotes.version)),
    db().select().from(schema.messages).where(eq(schema.messages.jobId, jobId)).orderBy(asc(schema.messages.createdAt)),
    db().select().from(schema.progressEvents).where(eq(schema.progressEvents.jobId, jobId)).orderBy(asc(schema.progressEvents.createdAt)),
    db().select().from(schema.findings).where(eq(schema.findings.jobId, jobId)).orderBy(asc(schema.findings.createdAt)),
    db().select().from(schema.payments).where(eq(schema.payments.jobId, jobId)).orderBy(asc(schema.payments.createdAt)),
    loadReport(job),
  ]);
  return {
    job: toPublicJob(job), quotes, messages, progress, findings, payments,
    ...(report ? { report } : {}),
  };
}

export async function getOperatorOverview() {
  const me = await getCurrentCustomer();
  if (!me?.isOperator) return null;
  const d = db();
  const [jobs, payments, sessions, interventions, outreach, perJobCost, totals] = await Promise.all([
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
      d.select({ s: sql<number>`coalesce(sum(${schema.payments.amountCents}), 0)::bigint` }).from(schema.payments)
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.payments.jobId))
        .where(and(eq(schema.payments.environment, "live"), eq(schema.jobs.isMock, false))),
      d.select({ s: sql<number>`coalesce(sum(${schema.costs.microUsd}), 0)::bigint` }).from(schema.costs),
    ]),
  ]);
  const costByJob: Record<string, number> = {};
  for (const r of perJobCost) if (r.jobId) costByJob[r.jobId] = Number(r.microUsd);
  return {
    liveRevenueCents: Number(totals[0][0]?.s ?? 0),
    knownCostMicroUsd: Number(totals[1][0]?.s ?? 0),
    costByJobMicroUsd: costByJob,
    jobs: jobs.map((j) => ({ ...toPublicJob(j), knownCostMicroUsd: costByJob[j.id] ?? 0 })),
    payments, agentSessions: sessions, interventions, outreachDrafts: outreach,
  };
}

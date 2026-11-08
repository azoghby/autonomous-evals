import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import type { JobState, Package } from "@ae/core/contracts/index";
import { recordProgress } from "@/server/job-store";
import type { ResumeSnapshot } from "../decisions";

const COUNTED_MILESTONES = ["received", "qualified", "connection_check_failed"] as const;
const CANCEL_REQUEST_PREFIX = "Cancellation requested:";

/**
 * Reads the persisted facts decideResumePlan needs. Plain function (also used by restartJobWorkflow before it
 * starts a run). Returns null for a missing job. Output carries no credentials: payment ids/amounts, quote
 * pricing, and the customer's own clarification answers (which already flow through step I/O).
 */
export async function loadResumeSnapshot(jobId: string): Promise<ResumeSnapshot | null> {
  const [job] = await db().select({ state: schema.jobs.state, package: schema.jobs.package, reportBlobPath: schema.jobs.reportBlobPath })
    .from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  if (!job) return null;
  const [quotes, payments, answers, milestones, findings, remediations] = await Promise.all([
    db().select().from(schema.quotes).where(eq(schema.quotes.jobId, jobId)).orderBy(desc(schema.quotes.version)).limit(1),
    db().select({
      id: schema.payments.id, quoteVersion: schema.payments.quoteVersion, status: schema.payments.status, kind: schema.payments.kind,
      amountCents: schema.payments.amountCents, currency: schema.payments.currency,
    }).from(schema.payments).where(eq(schema.payments.jobId, jobId)).orderBy(asc(schema.payments.createdAt)),
    db().select({ body: schema.messages.body }).from(schema.messages)
      .where(and(eq(schema.messages.jobId, jobId), eq(schema.messages.role, "customer"))).orderBy(asc(schema.messages.createdAt)),
    db().select({ milestone: schema.progressEvents.milestone, n: sql<number>`count(*)::int` }).from(schema.progressEvents)
      .where(and(eq(schema.progressEvents.jobId, jobId), inArray(schema.progressEvents.milestone, [...COUNTED_MILESTONES])))
      .groupBy(schema.progressEvents.milestone),
    db().select({ n: sql<number>`count(*)::int` }).from(schema.findings).where(eq(schema.findings.jobId, jobId)),
    db().select({ n: sql<number>`count(*)::int` }).from(schema.remediations).where(eq(schema.remediations.jobId, jobId)),
  ]);
  const q = quotes[0];
  const count = (m: (typeof COUNTED_MILESTONES)[number]) => milestones.find((r) => r.milestone === m)?.n ?? 0;
  return {
    state: job.state as JobState,
    package: job.package as Package,
    reportStored: Boolean(job.reportBlobPath),
    latestQuote: q ? { version: q.version, accepted: q.acceptedAt != null, pricingMode: q.pricingMode, priceCents: q.priceCents, capCents: q.capCents } : null,
    payments,
    clarificationAnswers: answers.map((a) => a.body).filter((b) => !b.startsWith(CANCEL_REQUEST_PREFIX)),
    qualifyCount: count("qualified"),
    connectionCheckFailures: count("connection_check_failed"),
    receivedRecorded: count("received") > 0,
    findingsCount: findings[0]?.n ?? 0,
    remediationsCount: remediations[0]?.n ?? 0,
  };
}

export async function loadResumeSnapshotStep(jobId: string): Promise<ResumeSnapshot> {
  "use step";
  const snap = await loadResumeSnapshot(jobId);
  // Same fallback as getStateStep: a vanished job reads as failed, so the run exits without touching anything.
  return snap ?? {
    state: "failed", package: "trace_audit", reportStored: false, latestQuote: null, payments: [], clarificationAnswers: [],
    qualifyCount: 0, connectionCheckFailures: 0, receivedRecorded: false, findingsCount: 0, remediationsCount: 0,
  };
}

/**
 * Before a restarted run re-evaluates, drops findings/remediations a dead run stored without finishing its report
 * (proposeFixStep saves them early). Otherwise the re-run's findings would mix with stale ones and per-finding
 * billing would count both. No-op once the report is stored or the job is no longer in a pre-delivery state.
 */
export async function discardPartialEvaluationStep(jobId: string): Promise<{ findings: number; remediations: number }> {
  "use step";
  const [job] = await db().select({ state: schema.jobs.state, reportBlobPath: schema.jobs.reportBlobPath })
    .from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  const preDelivery: readonly string[] = ["quoted", "awaiting_payment", "planning", "running", "investigating"];
  if (!job || job.reportBlobPath || !preDelivery.includes(job.state)) return { findings: 0, remediations: 0 };
  const rem = await db().delete(schema.remediations).where(eq(schema.remediations.jobId, jobId)).returning({ id: schema.remediations.id });
  const fnd = await db().delete(schema.findings).where(eq(schema.findings.jobId, jobId)).returning({ id: schema.findings.id });
  if (rem.length || fnd.length) {
    await recordProgress(jobId, "partial_results_discarded",
      `Internal note: discarded ${fnd.length} finding(s) and ${rem.length} fix(es) from an interrupted run before re-running the evaluation.`);
  }
  return { findings: fnd.length, remediations: rem.length };
}

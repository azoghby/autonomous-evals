import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import {
  PRICE_CENTS, JOB_BUDGET_MICRO_USD, CostEntry, type Finding, type JobState, type QualifyResult,
  type Quote, type Package, type Remediation, type IntakeInput, type Environment,
} from "@ae/core/contracts/index";
import type { ServiceContext } from "@ae/core/contracts/services";
import { decryptJson } from "@ae/core/storage/crypto";
import { readJobArtifactText } from "@ae/core/storage/blob";
import { injectCredentials, type CredentialMap } from "./intake";

export type JobRow = typeof schema.jobs.$inferSelect;

export interface JobStateExtra {
  error?: string | null;
  deliveredAt?: Date | null;
  neonBranchId?: string | null;
  reportBlobPath?: string | null;
  suiteBlobPath?: string | null;
  workflowRunId?: string | null;
  credentialsDeleteAfter?: Date | null;
  branchDeleteAfter?: Date | null;
  budgetReservedMicroUsd?: number;
}

export async function getJob(jobId: string): Promise<JobRow | null> {
  const [row] = await db().select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1);
  return row ?? null;
}

export async function setJobState(jobId: string, state: JobState, extra: JobStateExtra = {}): Promise<void> {
  await db().update(schema.jobs).set({ ...extra, state, updatedAt: new Date() }).where(eq(schema.jobs.id, jobId));
}

export async function recordProgress(jobId: string, milestone: string, message: string): Promise<void> {
  await db().insert(schema.progressEvents).values({ jobId, milestone: milestone.slice(0, 100), message: message.slice(0, 1000) });
}

export async function recordCost(entry: CostEntry): Promise<void> {
  const e = CostEntry.parse(entry);
  await db().insert(schema.costs).values({
    jobId: e.jobId, source: e.source, agent: e.agent ?? null, sessionId: e.sessionId ?? null, microUsd: e.microUsd, meta: e.meta,
  });
}

/** Persists findings. Idempotent per (jobId, findingKey): existing keys are left untouched (originals are never overwritten). */
export async function saveFindings(jobId: string, findings: Finding[], rerunOfFindingId?: string): Promise<void> {
  if (findings.length === 0) return;
  const existing = await db().select({ k: schema.findings.findingKey }).from(schema.findings)
    .where(and(eq(schema.findings.jobId, jobId), rerunOfFindingId ? eq(schema.findings.rerunOfFindingId, rerunOfFindingId) : sql`${schema.findings.rerunOfFindingId} is null`));
  const have = new Set(existing.map((r) => r.k));
  const fresh = rerunOfFindingId ? findings : findings.filter((f) => !have.has(f.id));
  if (fresh.length === 0) return;
  await db().insert(schema.findings).values(fresh.map((f) => ({
    jobId, findingKey: f.id, data: f, rerunOfFindingId: rerunOfFindingId ?? null,
  })));
}

export async function addMessage(jobId: string, role: "customer" | "commercial" | "operator" | "system", body: string): Promise<string> {
  const [row] = await db().insert(schema.messages).values({ jobId, role, body }).returning({ id: schema.messages.id });
  return row!.id;
}

/** Creates the next quote version. Price comes only from PRICE_CENTS, never from the agent. */
export async function createQuote(jobId: string, qualify: QualifyResult): Promise<Quote> {
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const pkg: Package = qualify.package;
  for (let attempt = 0; attempt < 3; attempt++) {
    const [{ max }] = await db().select({ max: sql<number>`coalesce(max(${schema.quotes.version}), 0)::int` })
      .from(schema.quotes).where(eq(schema.quotes.jobId, jobId));
    const version = max + 1;
    try {
      await db().insert(schema.quotes).values({
        jobId, version, package: pkg, priceCents: PRICE_CENTS[pkg],
        scopeSummary: qualify.scopeSummary, deliverables: qualify.deliverables,
      });
      return {
        jobId, version, package: pkg, priceCents: PRICE_CENTS[pkg], scopeSummary: qualify.scopeSummary,
        deliverables: qualify.deliverables, environment: job.environment,
      };
    } catch (err) {
      if (attempt === 2) throw err; // unique (job, version) race: retry with fresh max
    }
  }
  throw new Error("unreachable");
}

export interface JobWithCredentials {
  job: JobRow;
  /** Full intake including apiKeys and (rehydrated) trace. Server-only: never log or send to agents. */
  intake: IntakeInput;
  credentials: CredentialMap;
  credentialsPresent: boolean;
}

export async function getJobWithDecryptedCredentials(jobId: string): Promise<JobWithCredentials | null> {
  const job = await getJob(jobId);
  if (!job) return null;
  const [credRow] = await db().select().from(schema.jobCredentials).where(eq(schema.jobCredentials.jobId, jobId)).limit(1);
  const credentials = credRow ? decryptJson<CredentialMap>(credRow.ciphertext) : {};
  let stored = job.intake as Record<string, unknown>;
  if (job.traceBlobPath && typeof stored.trace !== "string") {
    const trace = await readJobArtifactText(job.traceBlobPath);
    if (trace === null) throw new Error(`Trace blob missing for job ${jobId}`);
    stored = { ...stored, trace };
  }
  return { job, intake: injectCredentials(stored, credentials) as IntakeInput, credentials, credentialsPresent: !!credRow };
}

export async function deleteJobCredentials(jobId: string): Promise<void> {
  await db().delete(schema.jobCredentials).where(eq(schema.jobCredentials.jobId, jobId));
}

export async function jobKnownCostMicroUsd(jobId: string): Promise<number> {
  const [r] = await db().select({ s: sql<number>`coalesce(sum(${schema.costs.microUsd}), 0)::bigint` })
    .from(schema.costs).where(eq(schema.costs.jobId, jobId));
  return Number(r?.s ?? 0);
}

export async function makeServiceContext(jobId: string): Promise<ServiceContext> {
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);
  const cap = JOB_BUDGET_MICRO_USD[job.package];
  const spent = await jobKnownCostMicroUsd(jobId);
  const environment: Environment = job.environment;
  return {
    jobId, environment,
    budgetMicroUsd: Math.max(0, cap - spent),
    recordCost: (entry) => recordCost({ ...entry, jobId }),
    recordProgress: (milestone, message) => recordProgress(jobId, milestone, message),
  };
}

export async function latestQuote(jobId: string) {
  const [q] = await db().select().from(schema.quotes).where(eq(schema.quotes.jobId, jobId)).orderBy(desc(schema.quotes.version)).limit(1);
  return q ?? null;
}

/** Row id of a job's original (non-rerun) finding with this key, or null. */
export async function findingRowIdByKey(jobId: string, findingKey: string): Promise<string | null> {
  const [row] = await db().select({ id: schema.findings.id }).from(schema.findings)
    .where(and(eq(schema.findings.jobId, jobId), eq(schema.findings.findingKey, findingKey), sql`${schema.findings.rerunOfFindingId} is null`)).limit(1);
  return row?.id ?? null;
}

/** Persists a validated fix for a finding row. Idempotent: one remediation per finding row (retries overwrite). */
export async function saveRemediation(jobId: string, findingRowId: string, remediation: Remediation): Promise<void> {
  await db().insert(schema.remediations).values({ jobId, findingRowId, data: remediation })
    .onConflictDoUpdate({ target: schema.remediations.findingRowId, set: { data: remediation } });
}

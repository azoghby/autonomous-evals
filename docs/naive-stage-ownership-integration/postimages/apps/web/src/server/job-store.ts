import "server-only";
import { currentWorkflowStageScope } from './workflow-stage-runtime';
import { publishWorkflowStage } from './workflow-stage-children';

/** A scoped publication must stay on the pinned owner-check transaction. */
function stageScopeFor(jobId:string) {
 const scope=currentWorkflowStageScope();
 if(scope && scope.owner.jobId!==jobId)throw new Error('workflow_stage_job_mismatch');
 return scope;
}

import { recordSettledCost } from "./cost-settlement";
import { createServiceAdapters } from "@ae/core/adapters/index";
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
  const scope=stageScopeFor(jobId);
  if(scope) {
    const columns:Record<keyof JobStateExtra,string>={error:'error',deliveredAt:'delivered_at',neonBranchId:'neon_branch_id',reportBlobPath:'report_blob_path',suiteBlobPath:'suite_blob_path',workflowRunId:'workflow_run_id',credentialsDeleteAfter:'credentials_delete_after',branchDeleteAfter:'branch_delete_after',budgetReservedMicroUsd:'budget_reserved_micro_usd'};
    const params:unknown[]=[jobId,state];
    const assignments=['state=$2','updated_at=now()'];
    for(const [key,value] of Object.entries(extra)) {
      if(!Object.prototype.hasOwnProperty.call(columns,key))throw new Error('workflow_stage_invalid_job_column');
      if(value===undefined)continue;
      params.push(value);assignments.push(`${columns[key as keyof JobStateExtra]}=$${params.length}`);
    }
    await publishWorkflowStage(tx=>tx.query(`UPDATE jobs SET ${assignments.join(',')} WHERE id=$1`,params),scope);
    return;
  }
  await db().update(schema.jobs).set({ ...extra, state, updatedAt: new Date() }).where(eq(schema.jobs.id, jobId));
}

export async function recordProgress(jobId: string, milestone: string, message: string): Promise<void> {
  const scope=stageScopeFor(jobId);
  if(scope) {
    await publishWorkflowStage(tx=>tx.query('INSERT INTO progress_events(job_id,milestone,message) VALUES($1,$2,$3)',[jobId,milestone.slice(0,100),message.slice(0,1000)]),scope);
    return;
  }
  await db().insert(schema.progressEvents).values({ jobId, milestone: milestone.slice(0, 100), message: message.slice(0, 1000) });
}

export async function recordCost(entry: CostEntry, expected?: { ownerId: string; environment: Environment }): Promise<void> {
  const e = CostEntry.parse(entry);
  await recordSettledCost({ kind: "job", id: e.jobId, ...expected }, e);
}

/** Persists findings. Idempotent per (jobId, findingKey): existing keys are left untouched (originals are never overwritten). */
export async function saveFindings(jobId: string, findings: Finding[], rerunOfFindingId?: string): Promise<void> {
  const scope=stageScopeFor(jobId);
  if (findings.length === 0) return;
  if(scope) {
    await publishWorkflowStage(async tx=>{
      const existing=await tx.query<{k:string}>('SELECT finding_key AS k FROM findings WHERE job_id=$1 AND rerun_of_finding_id IS NOT DISTINCT FROM $2::uuid',[jobId,rerunOfFindingId??null]);
      const have=new Set(existing.rows.map(r=>r.k));
      const fresh=rerunOfFindingId?findings:findings.filter(f=>!have.has(f.id));
      for(const finding of fresh)await tx.query('INSERT INTO findings(job_id,finding_key,data,rerun_of_finding_id) VALUES($1,$2,$3::jsonb,$4)',[jobId,finding.id,JSON.stringify(finding),rerunOfFindingId??null]);
    },scope);
    return;
  }
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
    recordCost: (entry) => recordCost({ ...entry, jobId }, { ownerId: job.customerId, environment }),
    recordProgress: (milestone, message) => recordProgress(jobId, milestone, message),
    ...createServiceAdapters(jobId),
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
  const scope=stageScopeFor(jobId);
  if(scope) {
    await publishWorkflowStage(async tx=>{
      const finding=(await tx.query<{id:string}>('SELECT id FROM findings WHERE id=$1 AND job_id=$2',[findingRowId,jobId])).rows[0];
      if(!finding)throw new Error('workflow_stage_finding_job_mismatch');
      await tx.query('INSERT INTO remediations(job_id,finding_row_id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(finding_row_id) DO UPDATE SET data=excluded.data',[jobId,findingRowId,JSON.stringify(remediation)]);
    },scope);
    return;
  }
  await db().insert(schema.remediations).values({ jobId, findingRowId, data: remediation })
    .onConflictDoUpdate({ target: schema.remediations.findingRowId, set: { data: remediation } });
}

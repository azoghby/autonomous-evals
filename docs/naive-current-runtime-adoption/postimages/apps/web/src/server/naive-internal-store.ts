import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentSqlExecutor } from '@ae/core/agents/postgres-ports';
export type { AgentSqlExecutor, AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
export interface ConfiguredPin { agentId: string; agentVersion: number }
export interface InternalCredential extends ConfiguredPin { id: string; role: 'copilot' }
export interface InternalTask extends ConfiguredPin {
  id: string; requestId: string; customerId: string; jobId: string; credentialId: string;
  role: 'copilot'; environment: 'test' | 'live'; nonce: string; issuedAt: number; expiresAt: number;
}
export type FreshOwner = (tx: AgentSqlExecutor) => Promise<{ customerId: string }>;
export type AuditOutcome = 'task_issued' | 'task_replayed' | 'task_revoked' | 'read_allowed' | 'auth_denied' | 'rate_limited' | 'request_denied' | 'read_denied' | 'internal_error';
const fail = (): never => { throw new Error('naive_internal_unauthorized'); };
function pinValid(pin: ConfiguredPin) {
  if (!pin || typeof pin.agentId !== 'string' || !pin.agentId || pin.agentId.length > 200 || !Number.isSafeInteger(pin.agentVersion) || pin.agentVersion < 1) fail();
}
const uuid = (value: string) => { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail(); };
const credentialColumns = `id,role,agent_id AS "agentId",agent_version AS "agentVersion"`;
const taskColumns = `id,request_id AS "requestId",customer_id AS "customerId",job_id AS "jobId",environment,credential_id AS "credentialId",role,agent_id AS "agentId",agent_version AS "agentVersion",nonce,issued_at::float8 AS "issuedAt",expires_at::float8 AS "expiresAt"`;
async function now(tx: AgentSqlExecutor) { return Number((await tx.query<{n:number}>('SELECT floor(extract(epoch FROM clock_timestamp()))::float8 AS n')).rows[0]?.n); }
export async function audit(tx: AgentSqlExecutor, outcome: AuditOutcome, ids: {credentialId?:string;taskId?:string} = {}) {
  if (!['task_issued','task_replayed','task_revoked','read_allowed','auth_denied','rate_limited','request_denied','read_denied','internal_error'].includes(outcome)) fail();
  await tx.query('INSERT INTO naive_internal.audit(id,credential_id,task_id,outcome) VALUES($1,$2,$3,$4)', [randomUUID(),ids.credentialId ?? null,ids.taskId ?? null,outcome]);
}
/** All entry points require a pinned READ COMMITTED transaction with rollback on any error.
 * Authentication callbacks are trusted server code and execute freshly inside that transaction.
 * Lock order is canonical job, credential, task; authorization locks remain held through projection. */
export async function authenticateCredential(tx: AgentSqlExecutor, bearerHash: string, pin: ConfiguredPin): Promise<InternalCredential> {
  pinValid(pin); if (!/^[a-f0-9]{64}$/.test(bearerHash)) fail();
  const rows = (await tx.query<InternalCredential>(`SELECT ${credentialColumns} FROM naive_internal.credentials WHERE bearer_sha256=$1 AND role='copilot' AND agent_id=$2 AND agent_version=$3 AND revoked_at IS NULL FOR SHARE`,[bearerHash,pin.agentId,pin.agentVersion])).rows;
  if (rows.length !== 1) fail(); return rows[0]!;
}
async function owner(tx: AgentSqlExecutor, jobId: string, fresh: FreshOwner) {
  uuid(jobId); const actor = await fresh(tx); if (!actor?.customerId) fail(); uuid(actor.customerId);
  const job = (await tx.query<{customer_id:string;environment:'test'|'live'}>('SELECT customer_id,environment FROM jobs WHERE id=$1 FOR UPDATE',[jobId])).rows[0];
  if (!job || job.customer_id !== actor.customerId) fail(); return {customerId:actor.customerId,environment:job.environment};
}
export async function issueTask(tx: AgentSqlExecutor, input:{jobId:string;requestId:string}, fresh:FreshOwner, pin:ConfiguredPin):Promise<InternalTask> {
  pinValid(pin); uuid(input.requestId); uuid(input.jobId);
  input = {jobId:input.jobId.toLowerCase(),requestId:input.requestId.toLowerCase()};
  const {customerId:customer,environment} = await owner(tx,input.jobId,fresh);
  const credentials = (await tx.query<InternalCredential>(`SELECT ${credentialColumns} FROM naive_internal.credentials WHERE role='copilot' AND agent_id=$1 AND agent_version=$2 AND revoked_at IS NULL FOR SHARE`,[pin.agentId,pin.agentVersion])).rows;
  if (credentials.length !== 1) fail(); const credential = credentials[0]!;
  const existing = (await tx.query<InternalTask & {revoked_at:unknown}>(`SELECT ${taskColumns},revoked_at FROM naive_internal.tasks WHERE customer_id=$1 AND job_id=$2 AND request_id=$3 FOR UPDATE`,[customer,input.jobId,input.requestId])).rows[0];
  const issuedAt = await now(tx); if (!Number.isSafeInteger(issuedAt)) fail();
  if (existing) {
    if (existing.environment !== environment || existing.revoked_at || existing.expiresAt <= issuedAt || existing.credentialId !== credential.id || existing.agentId !== pin.agentId || existing.agentVersion !== pin.agentVersion) fail();
    const {revoked_at:_,...task} = existing; await audit(tx,'task_replayed',{credentialId:credential.id,taskId:task.id}); return task;
  }
  const task:InternalTask = {id:randomUUID(),requestId:input.requestId,customerId:customer,jobId:input.jobId,credentialId:credential.id,role:'copilot',environment,agentId:pin.agentId,agentVersion:pin.agentVersion,nonce:randomBytes(32).toString('base64url'),issuedAt,expiresAt:issuedAt+300};
  await tx.query('INSERT INTO naive_internal.tasks(id,request_id,customer_id,job_id,credential_id,role,agent_id,agent_version,nonce,issued_at,expires_at,environment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[task.id,task.requestId,task.customerId,task.jobId,task.credentialId,task.role,task.agentId,task.agentVersion,task.nonce,task.issuedAt,task.expiresAt,task.environment]);
  await audit(tx,'task_issued',{credentialId:credential.id,taskId:task.id}); return task;
}
export async function revokeTask(tx:AgentSqlExecutor,jobId:string,taskId:string,fresh:FreshOwner) {
  uuid(taskId); const {customerId:customer} = await owner(tx,jobId,fresh);
  const owned = (await tx.query('SELECT id FROM naive_internal.tasks WHERE id=$1 AND job_id=$2 AND customer_id=$3 FOR UPDATE',[taskId,jobId,customer])).rows;
  if (owned.length !== 1) fail();
  const rows = (await tx.query<{id:string}>('UPDATE naive_internal.tasks SET revoked_at=clock_timestamp() WHERE id=$1 AND job_id=$2 AND customer_id=$3 AND revoked_at IS NULL RETURNING id',[taskId,jobId,customer])).rows;
  if (rows.length) await audit(tx,'task_revoked',{taskId}); return {revoked:rows.length===1};
}
export async function authorizeTask(tx:AgentSqlExecutor, claims:InternalTask, bearer:InternalCredential, pin:ConfiguredPin):Promise<InternalTask> {
  pinValid(pin); uuid(claims.id); uuid(claims.jobId);
  const job = (await tx.query<{customer_id:string;environment:'test'|'live'}>('SELECT customer_id,environment FROM jobs WHERE id=$1 FOR SHARE',[claims.jobId])).rows[0];
  if (!job || job.customer_id !== claims.customerId || job.environment !== claims.environment || bearer.role !== 'copilot' || bearer.id !== claims.credentialId || bearer.agentId !== pin.agentId || bearer.agentVersion !== pin.agentVersion) fail();
  const cred = (await tx.query<InternalCredential>(`SELECT ${credentialColumns} FROM naive_internal.credentials WHERE id=$1 AND revoked_at IS NULL FOR SHARE`,[bearer.id])).rows[0];
  if (!cred || cred.role !== bearer.role || cred.agentId !== bearer.agentId || cred.agentVersion !== bearer.agentVersion) fail();
  const row = (await tx.query<InternalTask & {revoked_at:unknown}>(`SELECT ${taskColumns},revoked_at FROM naive_internal.tasks WHERE id=$1 FOR SHARE`,[claims.id])).rows[0];
  if (!row || row.revoked_at) fail(); const {revoked_at:_,...task} = row;
  for (const key of Object.keys(task) as (keyof InternalTask)[]) if (task[key] !== claims[key]) fail();
  const time = await now(tx); if (!Number.isSafeInteger(time) || task.issuedAt > time || task.expiresAt <= time) fail();
  await audit(tx,'read_allowed',{credentialId:bearer.id,taskId:task.id}); return task;
}

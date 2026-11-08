import 'server-only';
import { createHash } from 'node:crypto';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import type { ServiceContext } from '@ae/core/contracts/services';
import { JOB_BUDGET_MICRO_USD } from '@ae/core/contracts/index';
import { canonicalJson } from '@ae/core/evals/text/index';
import { containsSecret } from '@ae/core/agents/redact';
import { createRichWorkflowServices, workflowSql } from './rich-services';
import { getJobWithDecryptedCredentials, makeServiceContext } from './job-store';
import { getEvalServices } from './services';
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
export class RerunRefusal extends Error { constructor(public status: number, message: string) { super(message); } }
const refuse = (message = 'Re-run requires operator reconciliation', status = 409): never => { throw new RerunRefusal(status, message); };
type Artifact = { format: string; suite: { digest?: string; hash?: string; scenarios: { id: string }[] }; run: { runId: string; branchId?: string; versionLabel?: string }; investigation: { findings: { id: string }[] }; appendedPack?: unknown };
export type RerunRequest = { jobId: string; findingId: string; ownerId: string; key: string };
type Authority = { environment: 'test' | 'live'; workflowRunId: string; targetVersion: string; baseline: Artifact; suiteDigest: string; findingKey: string; hold: number; secrets: string[]; digest: string };
/** Fresh owner, credential, binding and immutable artifact lookup; never accept a scenario or legacy finding evidence. */
export async function loadRerunAuthority(db: AgentTransactionalSql, request: RerunRequest): Promise<Authority> {
 const r = (await db.query<{ customer_id: string; environment: 'test' | 'live'; state: string; is_mock: boolean; workflow_run_id: string; package: string; neon_branch_id: string | null; ciphertext: string; target_revision: string; rerun_operation_micro_usd: string; suite_digest: string; body: Artifact; finding_key: string; rerun_of_finding_id: string | null }>(`SELECT j.customer_id,j.environment,j.state,j.is_mock,j.workflow_run_id,j.package,j.neon_branch_id,
 c.ciphertext,b.target_revision,b.rerun_operation_micro_usd,a.suite_digest,a.body,f.finding_key,f.rerun_of_finding_id
 FROM jobs j JOIN job_credentials c ON c.job_id=j.id JOIN workflow_integration.bindings b ON b.job_id=j.id
 JOIN workflow_integration.rich_artifacts a ON a.job_id=j.id AND a.tenant_id=j.customer_id AND a.environment=j.environment
 JOIN findings f ON f.job_id=j.id AND f.id=$2 WHERE j.id=$1 AND j.customer_id=$3`,[request.jobId,request.findingId,request.ownerId])).rows[0];
 if (!r) return refuse('Job or original finding unavailable',404);
 if (r.state !== 'delivered' || r.is_mock || !r.workflow_run_id || !r.ciphertext || !r.target_revision || r.rerun_of_finding_id) return refuse();
 const b = r.body;
 if (!['text_eval','workflow_eval'].includes(r.package) || !b || b.appendedPack || !['rich_text.v1','rich_text_remediation.v1','rich_calendar.v1'].includes(b.format)) return refuse('Unsupported scope; trace and appended-pack reruns require a separate integration');
 if ((r.package === 'workflow_eval') !== (b.format === 'rich_calendar.v1') || b.suite.scenarios.length !== 12 || (b.suite.digest ?? b.suite.hash) !== r.suite_digest || !b.run.runId || !b.investigation.findings.some(f=>f.id===r.finding_key)) return refuse('Rich baseline association refused');
 if (r.package === 'workflow_eval' && (!r.neon_branch_id || b.run.branchId !== r.neon_branch_id)) return refuse('Original Calendar branch unavailable; no replacement branch will be created');
 const hold=Number(r.rerun_operation_micro_usd);
 if (!Number.isSafeInteger(hold) || hold<=0) return refuse('Authorized rerun budget binding required');
 // The target hash is recalculated by rich-services before every target resolution.
 const loaded = await getJobWithDecryptedCredentials(request.jobId);
 if (!loaded || loaded.job.customerId !== request.ownerId || loaded.job.environment !== r.environment) return refuse();
 const secrets=Object.values(loaded.credentials).filter((v):v is string=>typeof v==='string');
 if (containsSecret(canonicalJson(b),secrets)) return refuse();
 const targetVersion=createHash('sha256').update(JSON.stringify({endpoint:{...('endpoint' in loaded.intake ? loaded.intake.endpoint : {}),apiKey:undefined},revision:r.target_revision,credentialCiphertext:r.ciphertext})).digest('hex');
 return {environment:r.environment,workflowRunId:r.workflow_run_id,targetVersion,baseline:b,suiteDigest:r.suite_digest,findingKey:r.finding_key,hold,secrets,
 digest:hash({owner:request.ownerId,environment:r.environment,workflow:r.workflow_run_id,targetVersion,branch:r.neon_branch_id,baseline:b,hold})};
}
type RichApi = Awaited<ReturnType<typeof createRichWorkflowServices>>;
/** Concrete adapters: both engines execute the retained full frozen12 (not an invented one-case suite).
 * Reproduction/investigator claims are never copied from the original finding. */
export async function runRichRerun(api: Pick<RichApi,'text'|'calendar'>, ctx: ServiceContext, a: Authority, operationId: string) {
 if (a.baseline.format === 'rich_calendar.v1') {
  const suiteId=operationId;
  const suite=await api.calendar.freezeSuite(ctx,{suiteId});
  if (suite.hash!==a.suiteDigest || canonicalJson(suite)!==canonicalJson(a.baseline.suite)) return refuse();
  const run=await api.calendar.runSuite(ctx,{suiteId,operationId,versionLabel:a.baseline.run.versionLabel ?? 'default'});
  return {format:'rich_calendar_rerun.v1',suite,run,limitations:['Full frozen12 rerun. Independent reproduction and remediation were not performed.']};
 }
 const suite=await api.text.getSuite(ctx,a.suiteDigest);
 if (suite.digest!==a.suiteDigest || canonicalJson(suite)!==canonicalJson(a.baseline.suite)) return refuse();
 const run=await api.text.rerun(ctx,{suiteDigest:a.suiteDigest,baselineRunId:a.baseline.run.runId,runId:operationId});
 return {format:'rich_text_rerun.v1',suite,run,limitations:['Full frozen12 rerun. Objective/rubric/infrastructure outcomes remain distinct; independent reproduction and remediation were not performed.']};
}
/** Committed claims are never leased/taken over. Crash before/after dispatch is explicitly ambiguous. */
export async function executeRerun(db: AgentTransactionalSql, request: RerunRequest,
 deps: { authority?: typeof loadRerunAuthority; context?: typeof makeServiceContext; services?: typeof createRichWorkflowServices; check?: (ctx: ServiceContext)=>Promise<void> } = {}) {
 if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(request.key)) return refuse('Idempotency-Key required (8-128 safe ASCII characters)',400);
 const authorize=()=> (deps.authority ?? loadRerunAuthority)(db,request);
 const a=await authorize(), inputDigest=hash({finding:request.findingId,contract:'rich_rerun.v1'});
 const operationId=`rerun:${hash({job:request.jobId,key:request.key})}`;
 const claim=await db.transaction(async tx=>{
  await tx.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[request.jobId]);
  const old=(await tx.query<{input_digest:string;authority_digest:string;state:string;result:unknown}>('SELECT input_digest,authority_digest,state,result FROM workflow_integration.finding_reruns WHERE job_id=$1 AND operation_key=$2',[request.jobId,request.key])).rows[0];
  if(old){if(old.input_digest!==inputDigest || old.authority_digest!==a.digest) return refuse('Idempotency key input or authority changed'); return {fresh:false,...old};}
  // Serialize admission against all finding keys and all reruns for this job.
  const usage=(await tx.query<{n:string;held:string}>(`SELECT count(*) FILTER (WHERE finding_id=$2) AS n,coalesce(sum(hold_micro_usd),0) AS held FROM workflow_integration.finding_reruns WHERE job_id=$1`,[request.jobId,request.findingId])).rows[0];
  const legacy=(await tx.query<{n:string}>('SELECT count(*) AS n FROM findings WHERE job_id=$1 AND rerun_of_finding_id=$2',[request.jobId,request.findingId])).rows[0];
  if(Number(usage.n)+Number(legacy.n)>=3) return refuse('Re-run limit reached (including pending operations)');
  const budget=(await tx.query<{spent:string;reserved:string;cap:number}>(`SELECT coalesce((SELECT sum(micro_usd) FROM costs WHERE job_id=$1),0) AS spent,coalesce((SELECT sum(micro_usd) FROM budget_reservations WHERE job_id=$1 AND released_at IS NULL),0) AS reserved`,[request.jobId])).rows[0];
  const cap=JOB_BUDGET_MICRO_USD[a.baseline.format==='rich_calendar.v1'?'workflow_eval':'text_eval'];
  if(Number(budget.spent)+Number(budget.reserved)+Number(usage.held)+a.hold>cap) return refuse('Re-run budget exhausted');
  await tx.query(`INSERT INTO workflow_integration.finding_reruns(job_id,operation_key,operation_id,finding_id,input_digest,authority_digest,hold_micro_usd,state) VALUES($1,$2,$3,$4,$5,$6,$7,'pending')`,[request.jobId,request.key,operationId,request.findingId,inputDigest,a.digest,a.hold]);
  return {fresh:true,state:'pending',result:null};
 });
 if(!claim.fresh && containsSecret(canonicalJson(claim.result),a.secrets)) return refuse();
 if(!claim.fresh) return {operationId,state:claim.state,result:claim.result,replayed:true};
 let api: RichApi | undefined;
 try {
  if((await authorize()).digest!==a.digest) return refuse();
  const ctx=await (deps.context ?? makeServiceContext)(request.jobId);
  ctx.budgetMicroUsd=Math.min(ctx.budgetMicroUsd,a.hold);
  if(deps.check) await deps.check(ctx); else {
   const loaded=await getJobWithDecryptedCredentials(request.jobId);
   if(!loaded || !('endpoint' in loaded.intake)) return refuse();
   if(!(await (await getEvalServices()).checkTarget(ctx,loaded.intake.endpoint)).ok) return refuse('Target policy refused');
  }
  api=await (deps.services ?? createRichWorkflowServices)(ctx,{workflowRunId:a.workflowRunId,rerun:{ownerId:request.ownerId,targetVersion:a.targetVersion}});
  await ctx.recordProgress('finding_rerun',`Re-run ${operationId} started; original baseline retained.`);
  const outcome=await runRichRerun(api,ctx,a,operationId);
  const report = {summary:`Re-run ${operationId} of ${request.findingId}; original baseline ${a.baseline.run.runId} retained.`,
   markdown:`Re-run ${operationId} uses suite ${a.suiteDigest} and target version ${a.targetVersion}. Full structured outcomes are retained in this separate result. Independent reproduction and fix verification are unassessed.`};
  const result={report,operationId,originalFindingId:request.findingId,findingKey:a.findingKey,baselineRunId:a.baseline.run.runId,suiteDigest:a.suiteDigest,targetVersion:a.targetVersion,...outcome};
  if(containsSecret(canonicalJson(result),a.secrets)) return refuse();
  await db.query(`UPDATE workflow_integration.finding_reruns SET state='completed',result=$3::jsonb WHERE job_id=$1 AND operation_key=$2 AND state='pending'`,[request.jobId,request.key,canonicalJson(result)]);
  await ctx.recordProgress('finding_rerun',`Re-run ${operationId} completed; separate rich result retained.`);
  return {operationId,state:'completed',result,replayed:false};
 } catch {
  // Completion acknowledgement may have been lost. Never erase a committed result.
  await db.query(`UPDATE workflow_integration.finding_reruns SET state='needs_operator' WHERE job_id=$1 AND operation_key=$2 AND state='pending'`,[request.jobId,request.key]).catch(()=>undefined);
  return {operationId,state:'needs_operator',result:null,replayed:false};
 } finally {await api?.dispose();}
}
export const rerunRichFinding = (request:RerunRequest)=>executeRerun(workflowSql(),request);
/** Private report appendices. Ownership is checked in SQL even after transport authorization. */
export async function readRichRerunsForOwner(jobId:string,ownerId:string,findingId?:string) {
 const rows=await workflowSql().query<{operation_id:string;finding_id:string;state:string;result:unknown}>(`SELECT r.operation_id,r.finding_id,r.state,r.result FROM workflow_integration.finding_reruns r JOIN jobs j ON j.id=r.job_id WHERE r.job_id=$1 AND j.customer_id=$2 AND ($3::uuid IS NULL OR r.finding_id=$3) ORDER BY r.created_at,r.operation_id`,[jobId,ownerId,findingId??null]);
 const loaded=await getJobWithDecryptedCredentials(jobId);
 const secrets=Object.values(loaded?.credentials??{}).filter((v):v is string=>typeof v==='string');
 if(rows.rows.some(r=>containsSecret(canonicalJson(r.result),secrets))) return refuse();
 return rows.rows.map(r=>({operationId:r.operation_id,originalFindingId:r.finding_id,state:r.state,result:r.result}));
}

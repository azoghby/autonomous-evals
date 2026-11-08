import 'server-only';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { reviewDigest } from '@ae/core/evals/data/binding';
import type { AuthenticatedDataReview } from '@ae/core/evals/data/orchestration';
export type ReviewResumeScope = {jobId:string;tenantId:string;environment:'test'|'live';workflowRunId:string};
const active = ['planning','running','investigating'];
async function authorized(sql:AgentTransactionalSql,s:ReviewResumeScope) {
 return (await sql.query<{state:string}>(`SELECT state FROM jobs WHERE id::text=$1 AND customer_id::text=$2 AND environment=$3
 AND workflow_run_id=$4 AND package='text_eval' AND is_mock=false`,[s.jobId,s.tenantId,s.environment,s.workflowRunId])).rows[0];
}
async function canonical(sql:AgentTransactionalSql,s:ReviewResumeScope,digest:string) {
 const row=(await sql.query<{result:AuthenticatedDataReview;result_digest:string;digest:string}>(`SELECT result,result_digest,digest FROM evaluation_data_persistence.operations
 WHERE tenant_id=$1 AND job_id=$2 AND operation_key=$3 AND state='complete'`,[s.tenantId,s.jobId,`authenticated-data-review:${digest}`])).rows[0];
 if(!row || row.result_digest!==reviewDigest(row.result) || row.digest!==row.result_digest || row.result.requestDigest!==digest
 || row.result.authority!=='authenticated_human' || !row.result.principalId || !['approved','rejected'].includes(row.result.decision)) return false;
 return true;
}
/** Called inside the SAME pinned transaction as the core authenticated review ledger writes. */
export async function enqueueReviewResume(sql:AgentTransactionalSql,s:ReviewResumeScope,requestDigest:string) {
 const job=await authorized(sql,s);
 if(!job || !active.includes(job.state) || !/^[a-f0-9]{64}$/.test(requestDigest) || !await canonical(sql,s,requestDigest)) throw new Error('review_resume_refused');
 const result=await sql.query(`INSERT INTO workflow_integration.review_resume_intents(job_id,request_digest,tenant_id,environment,workflow_run_id)
 VALUES($1,$2,$3,$4,$5) ON CONFLICT(job_id,request_digest) DO UPDATE SET job_id=EXCLUDED.job_id
 WHERE workflow_integration.review_resume_intents.tenant_id=EXCLUDED.tenant_id AND workflow_integration.review_resume_intents.environment=EXCLUDED.environment
 AND workflow_integration.review_resume_intents.workflow_run_id=EXCLUDED.workflow_run_id RETURNING job_id`,[s.jobId,requestDigest,s.tenantId,s.environment,s.workflowRunId]);
 if(result.rows.length!==1) throw new Error('review_resume_identity_conflict');
}
/** Waking is permission to re-read the authoritative data pipeline, NEVER permission to execute a target. */
export async function reviewWakeReady(sql:AgentTransactionalSql,s:ReviewResumeScope):Promise<boolean> {
 const job=await authorized(sql,s); if(!job || !active.includes(job.state)) return false;
 const rows=await sql.query<{request_digest:string}>(`SELECT request_digest FROM workflow_integration.review_resume_intents
 WHERE job_id=$1 AND tenant_id=$2 AND environment=$3 AND workflow_run_id=$4 AND status='pending' ORDER BY request_digest`,[s.jobId,s.tenantId,s.environment,s.workflowRunId]);
 for(const row of rows.rows) if(await canonical(sql,s,row.request_digest)) return true;
 return false;
}
export async function dispatchReviewResumes(sql:AgentTransactionalSql,api:{liveness(jobId:string,runId:string):Promise<'alive'|'dead'|'unknown'>;reenqueue(jobId:string,runId:string):Promise<void>},limit=50) {
 if(!Number.isSafeInteger(limit)||limit<1||limit>100) throw new Error('review_resume_limit');
 const rows=await sql.query<{job_id:string;request_digest:string;tenant_id:string;environment:'test'|'live';workflow_run_id:string}>(`SELECT * FROM workflow_integration.review_resume_intents WHERE status='pending' ORDER BY last_attempt_at,job_id,request_digest LIMIT $1`,[limit]);
 const summary={examined:rows.rows.length,reenqueued:0,held:0};
 for(const row of rows.rows) {
  const s={jobId:row.job_id,tenantId:row.tenant_id,environment:row.environment,workflowRunId:row.workflow_run_id};
  const job=await authorized(sql,s);
  let status='pending';
  if(!job || !active.includes(job.state)) status=job && ['delivered','cancelled','failed','declined'].includes(job.state)?'finished':'needs_operator';
  else if(await canonical(sql,s,row.request_digest)) {
   const live=await api.liveness(s.jobId,s.workflowRunId);
   if(live==='dead') status='needs_operator';
   else if(live==='alive') {
    // Recheck scope immediately before queue delivery; the step reauthorizes again.
    if(await reviewWakeReady(sql,s)) { await api.reenqueue(s.jobId,s.workflowRunId); summary.reenqueued++; }
   }
  }
  await sql.query('UPDATE workflow_integration.review_resume_intents SET status=$3,last_attempt_at=clock_timestamp() WHERE job_id=$1 AND request_digest=$2',[s.jobId,row.request_digest,status]);
  if(status==='needs_operator') summary.held++;
 }
 return summary;
}
/** Snapshot only intents visible BEFORE data advance, so a concurrent human completion is never acknowledged unseen. */
export async function captureReviewIntents(sql:AgentTransactionalSql,s:ReviewResumeScope) {
 if(!await authorized(sql,s))return [];
 return (await sql.query<{request_digest:string}>(`SELECT request_digest FROM workflow_integration.review_resume_intents WHERE job_id=$1 AND tenant_id=$2 AND environment=$3 AND workflow_run_id=$4 AND status='pending'`,[s.jobId,s.tenantId,s.environment,s.workflowRunId])).rows.map(r=>r.request_digest);
}
export async function finishReviewIntents(sql:AgentTransactionalSql,s:ReviewResumeScope,digests:string[]) {
 for(const digest of digests)await sql.query(`UPDATE workflow_integration.review_resume_intents SET status='finished' WHERE job_id=$1 AND tenant_id=$2 AND environment=$3 AND workflow_run_id=$4 AND request_digest=$5 AND status='pending'`,[s.jobId,s.tenantId,s.environment,s.workflowRunId,digest]);
}

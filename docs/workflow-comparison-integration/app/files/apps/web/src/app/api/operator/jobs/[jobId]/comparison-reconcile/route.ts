import { z } from 'zod';
import { requireOperator,readJson,jsonError,isUuid } from '@/server/http';
import { workflowSql } from '@/server/rich-services';
import { getJob } from '@/server/job-store';
import { comparisonDigest } from '@/server/rich-comparison';
const Input=z.object({operationId:z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),decision:z.enum(['retain_blocked','accept_retained_completion'])}).strict();
/** Records authoritative local evidence. Never unlocks, releases, or redispatches ambiguous operations. */
export async function POST(request:Request,context:{params:Promise<{jobId:string}>}) {
 const auth=await requireOperator();if(auth.res)return auth.res;
 const {jobId}=await context.params;if(!isUuid(jobId))return jsonError(404,'Not found');
 const input=await readJson(request,Input);if(!input.ok)return input.res;
 if(!await getJob(jobId))return jsonError(404,'Not found');
 const accepted=await workflowSql().transaction(async tx=>{
  const evidence=await tx.query<{kind:string;state:string;input_digest:string;value:unknown}>(`SELECT kind,state,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND id=$2 AND kind IN ('app_rich_tick','rich_comparison_identity','rich_comparison_baseline','rich_comparison_current') ORDER BY kind FOR UPDATE`,[jobId,input.data.operationId]);
  if(!evidence.rows.length)return false;
  if(input.data.decision==='accept_retained_completion'&&!evidence.rows.some(r=>r.kind==='app_rich_tick'&&r.state==='completed'))return false;
  await tx.query(`INSERT INTO workflow_comparison.reconciliation(job_id,operation_id,operator_id,evidence_digest,decision) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[jobId,input.data.operationId,auth.viewer.id,comparisonDigest(evidence.rows),input.data.decision]);
  return true;
 });
 return accepted?Response.json({recorded:true,redispatch:false}):jsonError(409,'No authoritative completion; preserve blocked claims and reservations');
}

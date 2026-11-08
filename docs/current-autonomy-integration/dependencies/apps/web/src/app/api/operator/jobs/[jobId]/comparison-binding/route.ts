import { requireOperator,readJson,jsonError,isUuid } from '@/server/http';
import { workflowSql } from '@/server/rich-services';
import { getJob } from '@/server/job-store';
import { comparisonProduction } from '@/server/comparison-production';
import { comparisonBindingSchema,comparisonDigest } from '@/server/rich-comparison';
import type { RichRunArtifact } from '@ae/core/monitoring/composition';
export async function POST(request:Request,context:{params:Promise<{jobId:string}>}) {
 const auth=await requireOperator();if(auth.res)return auth.res;
 const {jobId}=await context.params;if(!isUuid(jobId))return jsonError(404,'Not found');
 const input=await readJson(request,comparisonBindingSchema);if(!input.ok)return input.res;
 const job=await getJob(jobId);if(!job || job.state!=='delivered'||job.isMock)return jsonError(409,'Delivered rich job required');
 const sql=workflowSql(); const saved=await sql.query<{body:{format:string;suite:RichRunArtifact['suite'];run:RichRunArtifact['run'];investigation:unknown;limitations:string[]}}>('SELECT body FROM workflow_integration.rich_artifacts WHERE job_id=$1 AND tenant_id=$2 AND environment=$3',[jobId,job.customerId,job.environment]);
 const body=saved.rows[0]?.body;if(!body)return jsonError(409,'Retained original required');
 const retained={kind:body.format==='rich_text.v1'?'text':'calendar',suite:body.suite,run:body.run,investigation:body.investigation,limitations:body.limitations,costs:[],unknownCosts:['original_baseline_and_design_costs_not_measured_here']} as RichRunArtifact;
 const runtime=await comparisonProduction(jobId);
 try {
  const inventory=await runtime.verify(jobId,input.data,retained);
  if(comparisonDigest([...inventory.scenarioIds].sort())!==comparisonDigest([...input.data.scenarioIds].sort()))return jsonError(409,'Complete application inventory required');
  const digest=comparisonDigest({suite:body.suite,retained,binding:input.data});
  const inserted=await sql.query(`INSERT INTO workflow_comparison.bindings(job_id,suite,retained,binding,binding_digest) VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb,$5) ON CONFLICT DO NOTHING RETURNING job_id`,[jobId,JSON.stringify(body.suite),JSON.stringify(retained),JSON.stringify(input.data),digest]);
  if(!inserted.rows.length){const same=await sql.query('SELECT job_id FROM workflow_comparison.bindings WHERE job_id=$1 AND binding_digest=$2',[jobId,digest]);if(!same.rows.length)return jsonError(409,'Immutable admission conflict');}
  return Response.json({admitted:true,scope:input.data.scope,inventory:input.data.scenarioIds,packExecution:'unsupported',notifications:'draft_only'});
 }catch{return jsonError(409,'Canonical baseline/configuration review required');}finally{await runtime.dispose();}
}

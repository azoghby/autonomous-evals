import { z } from 'zod';
import { containsSecret } from '@ae/core/agents/redact';
import { draftFromAppendedInventory, freezePack, packReviewDigest, actualPackTargetDigest, canonicalPackJson } from '@ae/core/evals/packs/index';
import { requireOperator, readJson, jsonError, isUuid } from '@/server/http';
import { makeServiceContext, getJob } from '@/server/job-store';
import { createRichWorkflowServices, workflowSql } from '@/server/rich-services';
import { workflowPackRegistry } from '@/server/workflow-pack-registry';
const Input=z.object({authorizationId:z.string().uuid(),baseDigest:z.string().regex(/^[a-f0-9]{64}$/),
 scenarioIds:z.array(z.string().regex(/^rt_[a-z0-9_]+$/)).min(1).max(20),
 sourceRuleIds:z.array(z.string().min(1).max(256)).min(1).max(100),
 action:z.enum(['preview','approve']),contentDigest:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
/** Explicit authenticated human review. Not registered as an agent tool or reachable from intake. */
export async function POST(req:Request,context:{params:Promise<{jobId:string}>}) {
 const auth=await requireOperator();if(auth.res)return auth.res;
 const {jobId}=await context.params;if(!isUuid(jobId))return jsonError(404,'Not found');
 const body=await readJson(req,Input);if(!body.ok)return body.res;
 const job=await getJob(jobId);if(!job||job.package!=='text_eval'||!job.workflowRunId||job.isMock)return jsonError(404,'Not found');
 const api=await createRichWorkflowServices(await makeServiceContext(jobId),{workflowRunId:job.workflowRunId});
 try {
  const target=await api.resolvePackTarget();
  const baseSuite=await api.resolvePackBaseSuite(body.data.baseDigest);
  if(containsSecret(canonicalPackJson(body.data),target.knownSecrets))return jsonError(400,'Credential content refused');
  const draft=draftFromAppendedInventory({draft:{packId:'workflow-redteam',version:'1',baseDigest:body.data.baseDigest,
   authorization:{authorizationId:body.data.authorizationId,sourceRuleIds:body.data.sourceRuleIds,
    targetConfigDigest:actualPackTargetDigest(target.configuration)}},
   baseScenarioIds:baseSuite.scenarios.map(s=>s.id),
   sharedScenarioIds:[...baseSuite.scenarios.map(s=>s.id),...body.data.scenarioIds]});
  const contentDigest=packReviewDigest(draft,workflowPackRegistry);
  const manifest=freezePack(draft,workflowPackRegistry,{reviewerId:auth.viewer.id,reviewedAt:new Date().toISOString(),contentDigest});
  if(body.data.action==='preview')return Response.json({draft,contentDigest,inventory:manifest.inventory,
   instruction:'Review every case, quarantine and source-rule reference; approve this exact digest explicitly.'});
  if(body.data.contentDigest!==contentDigest)return jsonError(409,'Reviewed content changed; preview again');
  // One immutable authorization per job. Even a fresh Workflow run cannot reset dispatch identities.
  const inserted=await workflowSql().query(`INSERT INTO workflow_integration.pack_approvals
   (job_id,tenant_id,environment,authorization_id,manifest,source_rules,reviewed_by,reviewed_at)
   VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) ON CONFLICT(job_id) DO NOTHING RETURNING job_id`,
   [jobId,job.customerId,job.environment,body.data.authorizationId,canonicalPackJson(manifest),
    JSON.stringify(body.data.sourceRuleIds),auth.viewer.id,manifest.review.reviewedAt]);
  if(!inserted.rows.length)return jsonError(409,'Approval already exists; retain its identity and reconcile existing work');
  return Response.json({selection:{authorizationId:body.data.authorizationId},manifest});
 } catch {return jsonError(409,'Pack approval refused; operator review required');}
 finally {await api.dispose();}
}

/** Authorized discovery of the retained design for the explicit preview/approval round trip. */
export async function GET(_req:Request,context:{params:Promise<{jobId:string}>}) {
 const auth=await requireOperator();if(auth.res)return auth.res;
 const {jobId}=await context.params;if(!isUuid(jobId))return jsonError(404,'Not found');
 const job=await getJob(jobId);if(!job||job.package!=='text_eval'||!job.workflowRunId||job.isMock)return jsonError(404,'Not found');
 const api=await createRichWorkflowServices(await makeServiceContext(jobId),{workflowRunId:job.workflowRunId});
 try {
  const target=await api.resolvePackTarget();
  const baseSuite=await api.resolvePackBaseSuite();
  if(containsSecret(canonicalPackJson(baseSuite),target.knownSecrets))return jsonError(409,'Base suite refused');
  return Response.json({baseSuite,baseDigest:baseSuite.digest},{headers:{'Cache-Control':'private, no-store'}});
 } catch {return jsonError(409,'Base suite unavailable; complete retained data review/admission or base12 design, then retry');}
 finally {await api.dispose();}
}

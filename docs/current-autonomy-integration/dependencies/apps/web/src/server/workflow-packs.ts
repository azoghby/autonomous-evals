import 'server-only';
import { z } from 'zod';
import { createPackExecutionService, createSecuredTextPackRunner, actualPackTargetDigest,
  verifyPack, canonicalPackJson, type FrozenPack, type PackRunEvidence } from '@ae/core/evals/packs/index';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/index';
import type { FrozenTextSuite, SuiteRun } from '@ae/core/evals/text/schema';
import { createRichWorkflowServices, workflowSql } from './rich-services';
import { makeServiceContext } from './job-store';
import { workflowPackRegistry, workflowPackGrader } from './workflow-pack-registry';
export const WorkflowPackSelection = z.object({ authorizationId: z.string().uuid() }).strict();
export type WorkflowPackSelection = z.infer<typeof WorkflowPackSelection>;
export const workflowPackRunId = (jobId: string) => `pack:${jobId}:baseline`;
export interface WorkflowPackInput {
 jobId: string; environmentId: 'test' | 'live'; workflowRunId: string; agentId: string;
 baseSuite: FrozenTextSuite; baseRun: SuiteRun | null; selection: WorkflowPackSelection;
}
async function approval(input: WorkflowPackInput, api: Awaited<ReturnType<typeof createRichWorkflowServices>>) {
 const selection = WorkflowPackSelection.parse(input.selection);
 const sql = workflowSql();
   const row=(await sql.query<{manifest:unknown;source_rules:unknown;reviewed_by:string;reviewed_at:Date|string}>(
    `SELECT p.manifest,p.source_rules,p.reviewed_by,p.reviewed_at FROM workflow_integration.pack_approvals p
     JOIN jobs j ON j.id=p.job_id AND j.customer_id=p.tenant_id AND j.environment=p.environment
     WHERE p.job_id=$1 AND p.tenant_id=$2 AND p.environment=$3 AND p.authorization_id=$4
       AND p.revoked_at IS NULL AND j.workflow_run_id=$5`,
     [input.jobId,api.job.customerId,input.environmentId,selection.authorizationId,input.workflowRunId])).rows[0];
   if(!row)throw new Error('pack_operator_approval_required');
   const manifest=verifyPack(row.manifest,workflowPackRegistry);
   if(manifest.authorization.authorizationId!==selection.authorizationId
     || manifest.review.reviewerId!==row.reviewed_by
     || new Date(manifest.review.reviewedAt).getTime()!==new Date(row.reviewed_at).getTime()
     || canonicalPackJson(manifest.authorization.sourceRuleIds)!==canonicalPackJson(row.source_rules))throw new Error('pack_operator_receipt_mismatch');
   const target=await api.resolvePackTarget();
   if (manifest.baseDigest !== input.baseSuite.digest
     || manifest.authorization.targetConfigDigest !== actualPackTargetDigest(target.configuration)) throw new Error('pack_base_or_target_changed');
   const base=await api.text.getSuite(await makeServiceContext(input.jobId), input.baseSuite.digest);
   if (canonicalPackJson(base)!==canonicalPackJson(input.baseSuite)) throw new Error('pack_base_scope_changed');
   return manifest;
  }
/** Read-only, fresh authority fence before baseline dispatch. No target is sent here. */
export async function authorizeWorkflowPack(input: WorkflowPackInput): Promise<void> {
 const ctx=await makeServiceContext(input.jobId);
 if(ctx.environment!==input.environmentId || input.baseSuite.jobId!==input.jobId || !input.agentId) throw new Error('pack_scope');
 const api=await createRichWorkflowServices(ctx,{workflowRunId:input.workflowRunId});
 try {await approval(input, api);} finally {await api.dispose();}
}
/** Internal Workflow authority, never expose as an intake/agent tool or customer route. */
export async function executeWorkflowPack(raw: WorkflowPackInput): Promise<PackRunEvidence> {
 const input: WorkflowPackInput = structuredClone(raw);
 const selection = WorkflowPackSelection.parse(input.selection);
 if (input.baseSuite.jobId !== input.jobId || !input.agentId) throw new Error('pack_job_scope');
 const ctx = await makeServiceContext(input.jobId);
 if(ctx.environment!==input.environmentId)throw new Error('pack_environment_scope');
 const api = await createRichWorkflowServices(ctx, {workflowRunId:input.workflowRunId});
 try {
  const sql=workflowSql();
  const manifest=await approval(input, api);
  const target=await api.resolvePackTarget();
  const runner=createSecuredTextPackRunner({...target,registry:workflowPackRegistry,grader:workflowPackGrader});
  const service=createPackExecutionService({checkpoints:new PostgresTextCheckpointStore(sql),registry:workflowPackRegistry,runner,
   resolve:async jobId=>{
    if(jobId!==input.jobId)throw new Error('pack_job_scope');
    const current=await api.resolvePackTarget(); // rechecks stored Workflow, credentials and target revision
    const approved=await approval(input, api);
    return {jobId,environment:input.environmentId,authorizationId:selection.authorizationId,
      sourceRuleIds:approved.authorization.sourceRuleIds,targetConfigDigest:actualPackTargetDigest(current.configuration)};
   },
   verifyReview:async (value:FrozenPack)=>{
    if(canonicalPackJson(await approval(input, api))!==canonicalPackJson(value))throw new Error('pack_review_changed');
   },
  });
  await service.run({runId:workflowPackRunId(input.jobId),manifest,baseSuite:input.baseSuite,baseRun:input.baseRun});
  return await service.report(input.jobId,workflowPackRunId(input.jobId));
 } finally {await api.dispose();}
}
/** Selection contains only a durable reference, never approval or executable scenario specs. */
export async function workflowPackSelection(jobId:string):Promise<WorkflowPackSelection> {
 const row=(await workflowSql().query<{authorization_id:string}>(
  'SELECT authorization_id FROM workflow_integration.pack_approvals WHERE job_id=$1 AND revoked_at IS NULL',[jobId])).rows[0];
 if(!row)throw new Error('pack_operator_approval_required');
 return WorkflowPackSelection.parse({authorizationId:row.authorization_id});
}

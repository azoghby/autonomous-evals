import { requireCronAuth } from '../_auth';
import { workflowSql } from '@/server/rich-services';
import { dispatchReviewResumes } from '@/server/workflow-resumption';
import { getHookByToken, getRun } from 'workflow/api';
import { getWorld } from 'workflow/runtime';
import { reenqueueRun } from '@workflow/core/runtime';
import { jobHookToken } from '@ae/core/contracts/index';
export async function GET(request:Request) {
 const denied=requireCronAuth(request);if(denied)return denied;
 try {
  const summary=await dispatchReviewResumes(workflowSql(),{
   async liveness(jobId,runId) {
    try {
     const hook=await getHookByToken(jobHookToken(jobId));
     if(hook.runId!==runId)return 'unknown';
     const status=await getRun(runId).status;
     return status==='pending'||status==='running'?'alive':'dead';
    } catch(error) {
     return error instanceof Error && ['HookNotFoundError','WorkflowRunNotFoundError'].includes(error.name)?'dead':'unknown';
    }
   },
   async reenqueue(jobId,runId) {
    const hook=await getHookByToken(jobHookToken(jobId));
    if(hook.runId!==runId)throw new Error('review_resume_owner_changed');
    await reenqueueRun(await getWorld(),runId);
   }
  });
  return Response.json(summary);
 }catch{return Response.json({error:'Review resumption unavailable'},{status:503});}
}

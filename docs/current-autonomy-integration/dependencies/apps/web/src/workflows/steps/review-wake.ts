import { workflowSql } from '@/server/rich-services';
import { getJob } from '@/server/job-store';
import { reviewWakeReady } from '@/server/workflow-resumption';
export async function reviewWakeStep(jobId:string,workflowRunId:string) {
 'use step';
 const job=await getJob(jobId);
 if(!job || job.workflowRunId!==workflowRunId || job.isMock || !['planning','running','investigating'].includes(job.state)) return 'stop' as const;
 return reviewWakeReady(workflowSql(),{jobId,tenantId:job.customerId,environment:job.environment,workflowRunId});
}
reviewWakeStep.maxRetries=0;

import { getJob } from '@/server/job-store';
import { workflowSql } from '@/server/rich-services';
import { createWorkflowInventory } from '@/server/workflow-inventory';
/** Touch-only authority permits delivered jobs; never creates a provider runtime. */
export async function refreshRichInventoryStep(jobId: string, workflowRunId: string): Promise<void> {
  'use step';
  const job = await getJob(jobId);
  if (!job || job.workflowRunId !== workflowRunId || job.isMock) throw new Error('workflow_inventory_authority');
  if (job.package !== 'text_eval' && job.package !== 'workflow_eval') return;
  await createWorkflowInventory(workflowSql(), {jobId,tenantId:job.customerId,environment:job.environment}).touch();
}

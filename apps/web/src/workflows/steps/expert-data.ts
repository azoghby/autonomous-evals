import { advanceJobExpertData, type ExpertDataGate } from '@/server/expert-workflow';
import { recordProgress } from '@/server/job-store';

/** Every timer creates a fresh step invocation; an earlier pending result is never replayed as fresh state. */
export async function expertDataGateStep(jobId: string): Promise<ExpertDataGate> {
  'use step';
  try { return await advanceJobExpertData(jobId); }
  catch (error) {
    // Missing migration/configuration, authorization or durable reconciliation stays explicit pending.
    // In particular it never falls through to lite design/execution or the job failure handler.
    // Log the cause (name/message only, never data) so a missing sidecar migration is not a silent 7-day hold.
    console.error('expert_data_gate_pending', jobId, error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : 'non_error_throw');
    return 'pending';
  }
}
expertDataGateStep.maxRetries = 0;

export async function expertDataHoldStep(jobId: string, ready: boolean): Promise<void> {
  'use step';
  try { await recordProgress(jobId, ready ? 'expert_data_consumer_required' : 'expert_data_pending', ready
    ? 'Reviewed evaluation data is ready. Evaluation is waiting for the approved frozen-suite execution integration.'
    : 'Evaluation data is pending expert contributions, authenticated review, or durable reconciliation.'); } catch { /* Durable checkpoint stays pending even if progress storage is unavailable. */ }
}

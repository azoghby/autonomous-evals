import 'server-only';
import { setJobState } from './job-store';
import { expertOwnerDatabase } from './automated-expert-owner';
import { advanceExpertProductionData, type ProductionDataInput } from './expert-data-production';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { inspectDataSafety } from '@ae/core/evals/data/quality';

export type ExpertDataGate = 'legacy' | 'pending' | 'ready' | 'stopped';
/** Canonical opt-in plan is installed by trusted owner SQL only, never by an endpoint/model.
 * This is the real application's acquisition entry; it does not substitute a new evaluator.
 * Ready hands the exact canonical frozen suite to the authorized rich execution consumer.
 */
export async function advanceJobExpertData(jobId: string): Promise<ExpertDataGate> {
  const sql = expertOwnerDatabase();
  const result = await sql.query<{ input: ProductionDataInput; input_digest: string; topic: string;
    enabled: boolean; before_deadline: boolean; state: string; package: string; is_mock: boolean; customer_id: string; tenant_id: string }>(
    `SELECT p.input,p.input_digest,p.topic,p.enabled,p.response_deadline>now() AS before_deadline,j.state,j.package,j.is_mock,j.customer_id::text,p.tenant_id::text
     FROM expert_workflow.plans p JOIN jobs j ON j.id=p.job_id WHERE p.job_id=$1`, [jobId]);
  const row = result.rows[0];
  if (!row) return 'legacy';
  if (!row.enabled || !row.before_deadline || row.customer_id !== row.tenant_id || row.package !== 'text_eval' || row.is_mock
    || ['cancelled','failed','delivered','paused_budget','payment_review'].includes(row.state)) return 'stopped';
  if (row.input.task.jobId !== jobId || reviewDigest(row.input) !== row.input_digest
    || !inspectDataSafety({ input: row.input, topic: row.topic }).safe) return 'pending';
  if (row.state === 'awaiting_payment') await setJobState(jobId,'planning');
  const advanced = await advanceExpertProductionData(jobId, row.input, row.topic);
  // SQL holds the private result, including evidence and corpus. Workflow serialization sees a tag only.
  const published = await sql.query(`UPDATE expert_workflow.plans p SET last_result=$2::jsonb,last_checked_at=now()
    FROM jobs j WHERE p.job_id=$1 AND p.input_digest=$3 AND p.enabled AND p.response_deadline>now()
    AND j.id=p.job_id AND j.customer_id=p.tenant_id AND j.state IN ('planning','running','investigating') RETURNING p.job_id`, [jobId,JSON.stringify(advanced),row.input_digest]);
  if (published.rows.length !== 1) return 'pending';
  return advanced.status === 'ready' && advanced.frozen ? 'ready' : 'pending';
}

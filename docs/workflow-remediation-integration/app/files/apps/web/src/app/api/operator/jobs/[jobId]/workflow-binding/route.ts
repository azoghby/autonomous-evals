import { z } from 'zod';
import { containsSecret } from '@ae/core/agents/redact';
import { freezeCalendarSuite, type CalendarSuiteInput } from '@ae/core/simulator/workflow/index';
import { requireOperator, readJson, jsonError, isUuid } from '@/server/http';
import { getJobWithDecryptedCredentials } from '@/server/job-store';
import { workflowSql } from '@/server/rich-services';

const Input = z.object({ targetRevision: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  calendar: z.unknown().optional(), remediation: z.object({ isolation: z.literal('request_messages_only'), operationMicroUsd: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().optional() }).strict();
/** Human operator admission, never customer/model review authority. Repeated exact admission replays. */
export async function POST(req: Request, context: { params: Promise<{ jobId: string }> }) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const { jobId } = await context.params;
  if (!isUuid(jobId)) return jsonError(404, 'Not found');
  const body = await readJson(req, Input);
  if (!body.ok) return body.res;
  const loaded = await getJobWithDecryptedCredentials(jobId);
  if (!loaded || loaded.job.isMock || !['text_eval','workflow_eval'].includes(loaded.job.package)) return jsonError(404,'Not found');
  let calendar: CalendarSuiteInput | null = null;
  if (loaded.job.package === 'workflow_eval') {
    try {
      const proposed = body.data.calendar as CalendarSuiteInput;
      if (!proposed || proposed.jobId !== jobId || proposed.review?.reviewerId !== auth.viewer.id || proposed.review.approved !== true) throw new Error();
      // Exactly twelve reviewed cases. Appended 32-case packs are explicitly rejected by the engine.
      const { hash: _hash, ...frozen } = freezeCalendarSuite(proposed);
      if (frozen.origin === 'internal_fixture') throw new Error(); // fixtures use dedicated server seeding, not this customer intake
      calendar = frozen;
    } catch { return jsonError(400,'Exactly twelve valid cases and authenticated operator review required; appended packs are unsupported.'); }
    if (body.data.remediation) return jsonError(400,'Prompt remediation is only supported for text jobs');
  } else if (body.data.calendar !== undefined) return jsonError(400,'Calendar suite is not valid for text jobs');
  const secrets = Object.values(loaded.credentials).filter((v): v is string => typeof v === 'string');
  if (secrets.some(s => s.length < 4) || containsSecret(JSON.stringify(body.data), secrets)) return jsonError(400,'Credential content refused');
  const db = workflowSql();
  const result = await db.query(`INSERT INTO workflow_integration.bindings(job_id,target_revision,reviewed_calendar,admitted_by,isolation,remediation_operation_micro_usd)
    VALUES($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT(job_id) DO UPDATE SET job_id=EXCLUDED.job_id
    WHERE workflow_integration.bindings.target_revision=EXCLUDED.target_revision
      AND workflow_integration.bindings.reviewed_calendar IS NOT DISTINCT FROM EXCLUDED.reviewed_calendar
      AND workflow_integration.bindings.admitted_by=EXCLUDED.admitted_by
      AND workflow_integration.bindings.isolation IS NOT DISTINCT FROM EXCLUDED.isolation
      AND workflow_integration.bindings.remediation_operation_micro_usd IS NOT DISTINCT FROM EXCLUDED.remediation_operation_micro_usd RETURNING job_id`,
    [jobId,body.data.targetRevision,calendar ? JSON.stringify(calendar) : null,auth.viewer.id,body.data.remediation?.isolation??null,body.data.remediation?.operationMicroUsd??null]);
  if (result.rows.length !== 1) return jsonError(409,'Admission identity conflict; existing evidence must be reconciled');
  return Response.json({ admitted: true, scope: 'frozen12', richPack: 'unsupported' });
}

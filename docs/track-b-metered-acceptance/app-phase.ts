/** Owner-applyable metered single-binding rich app execution kernel. This emits actual facts, never
 * acceptance flags. The combined app cannot run a selected Calendar subset or bind
 * two endpoints to the same frozen Calendar suite, so full acceptance stays gated. */
import { createHash } from 'node:crypto';
import { createRichWorkflowServices, workflowSql } from '@/server/rich-services';
import { persistRichArtifact, readRichArtifact } from '@/server/rich-artifacts';
import { recordCost, recordProgress } from '@/server/job-store';
import type { ServiceContext } from '@ae/core/contracts/services';
import type { AcceptanceRuntime } from '@/server/acceptance-runtime';
import { canonicalJson } from '@ae/core/evals/text';

type Ref = { jobId: string; workflowRunId: string; environment: 'test' | 'live'; tenantId: string; budgetMicroUsd: number };
type CalendarRequest = { suiteId: string; operationId: string; versionLabel: string };
export type PhaseInput = Ref & { phase: 'baseline' | 'restart' } & (
  { package: 'text_eval'; suiteDigest: string; runId: string; findingId?: string } |
  { package: 'workflow_eval'; request: CalendarRequest }
);
const hash = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
export async function executeAppPhase(input: PhaseInput, runtime: AcceptanceRuntime) {
  runtime.signal.throwIfAborted(); // Internal only; outer preflight must precede this entrypoint.
  const sql = workflowSql();
  const ctx: ServiceContext = { jobId: input.jobId, environment: input.environment, budgetMicroUsd: input.budgetMicroUsd,
    recordCost: async cost => { await recordCost({ ...cost, jobId: input.jobId }); },
    recordProgress: async event => { await recordProgress(input.jobId, 'app_acceptance', JSON.stringify(event)); } };
  const api = await createRichWorkflowServices(ctx, { workflowRunId: input.workflowRunId, acceptanceRuntime: runtime });
  try {
    if (api.job.package !== input.package) throw new Error('canonical_package_mismatch');
    let body: unknown, suiteDigest: string;
    if (input.package === 'text_eval') {
      if (input.phase === 'baseline') {
        await api.text.runSuite(ctx, { suiteDigest: input.suiteDigest, runId: input.runId });
        await api.text.investigate(ctx, { suiteDigest: input.suiteDigest, runId: input.runId });
        await api.bindTextBaseline(input.suiteDigest, input.runId);
      }
      const baseline = await api.text.reportInput(ctx, { suiteDigest: input.suiteDigest, runId: input.runId });
      const findingId = input.findingId ?? baseline.richFindings.find(f => f.label === 'confirmed')?.id;
      if (!findingId) throw new Error('actual_confirmed_text_finding_required');
      const remediation = await api.remediation.proposeAndVerifyFixDetailed(ctx, { findingId });
      const report = input.phase === 'baseline' ? await api.renderReport(ctx, { intake: api.intake, findings: [], richFindings: baseline.richFindings,
        limitations: [...baseline.limitations, remediation.scope, remediation.reason] }) : undefined;
      body = { format: 'app_acceptance_text_facts.v2', baseline, remediation, report };
      suiteDigest = baseline.suite.digest;
    } else {
      if (input.phase === 'baseline') {
        await api.calendar.freezeSuite(ctx, input.request);
        await api.calendar.runSuite(ctx, input.request);
        await api.calendar.investigate(ctx, input.request);
      }
      const calendar = await api.calendar.reportInput(ctx, input.request);
      const report = input.phase === 'baseline' ? await api.renderReport(ctx, { intake: api.intake, findings: [], limitations: calendar.limitations }) : undefined;
      body = { format: 'app_acceptance_calendar_facts.v2', calendar, report };
      suiteDigest = calendar.suite.hash;
    }
    // One immutable artifact per job. Restart reads retained bytes and never rerenders.
    if (input.phase === 'baseline') await persistRichArtifact(sql, input, suiteDigest, body, api.knownSecrets);
    const persisted = await readRichArtifact(sql, input.jobId, input.tenantId, api.knownSecrets);
    if (!persisted || (input.phase === 'baseline' && hash(persisted) !== hash(body))) throw new Error('persisted_private_report_missing_or_changed');
    const operations = await sql.query('SELECT * FROM remediation_accounting.operations WHERE job_id=$1 ORDER BY operation_id', [input.jobId]);
    const costs = await sql.query('SELECT * FROM workflow_integration.provider_costs WHERE job_id=$1 ORDER BY key', [input.jobId]);
    return { source: 'actual_app_facts_unaccepted', processId: process.pid, phase: input.phase, package: input.package,
      persisted, reportDigest: hash(persisted), operations: operations.rows, costs: costs.rows };
  } finally { await api.dispose(); }
}

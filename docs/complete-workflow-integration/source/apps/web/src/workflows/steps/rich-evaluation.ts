import { TrackBBlockedError, TrackBPendingError } from '@ae/core/evals/service-adapter';
import { Report } from '@ae/core/contracts/index';
import { calendarOperationRunId } from '@ae/core/evals/calendar-integration/index';
import { renderCalendarReport } from '@ae/core/reporting/calendar';
import { containsSecret } from '@ae/core/agents/redact';
import { createRichWorkflowServices, workflowSql } from '@/server/rich-services';
import { persistRichArtifact } from '@/server/rich-artifacts';
import { getJob, recordProgress, setJobState } from '@/server/job-store';
import { createBranchStep, persistReportStep } from './evaluate';
import { withBudget } from './common';

type RichOutcome = 'complete' | 'pending' | 'needs_operator' | 'paused_budget';
/** No decrypted intake, raw response, endpoint or pool connection leaves this step. */
export async function richEvaluationStep(jobId: string, workflowRunId: string): Promise<RichOutcome> {
  'use step';
  let authorized = false;
  try {
    // Rich engines freeze exactly twelve. Appending Track A's default 32-case
    // rt_* pack would silently skip paid scope: explicit operator decision required.
    if (!/^(0|false|off|no)$/i.test(process.env.REDTEAM_PACK ?? '')) {
      throw new TrackBBlockedError('needs_operator', 'Set REDTEAM_PACK=off for frozen12; appended32 requires an agreed rich-pack integration.');
    }
    const canonical = await getJob(jobId);
    if (!canonical || canonical.workflowRunId !== workflowRunId || canonical.isMock
      || ['failed', 'cancelled', 'delivered'].includes(canonical.state)) throw new TrackBBlockedError('rejected_input', 'Workflow authority refused.');
    authorized = true;
    await setJobState(jobId, 'planning');
    const result = await withBudget(jobId, 'engineer', async ctx => {
      if (canonical.package === 'workflow_eval') await createBranchStep(jobId);
      const api = await createRichWorkflowServices(ctx, { workflowRunId });
      try {
      const { job, intake, inventory } = api;
      const tasks = await workflowSql().query<{ task_id: string }>(
        'SELECT task_id FROM evaluation_data_persistence.tasks WHERE tenant_id=$1 AND job_id=$2 ORDER BY task_id', [job.customerId, jobId]);
      if (tasks.rows.length && intake.package !== 'text_eval') {
        await inventory.acquisition(tasks.rows.map(row => row.task_id));
        throw new TrackBBlockedError('needs_operator', 'Data acquisition requires the authenticated review and frozen-suite bridge; no data completion is claimed.');
      }
      if (intake.package !== 'text_eval' && intake.package !== 'workflow_eval') throw new TrackBBlockedError('needs_operator', 'This rich path supports single-version frozen12 only.');
      // Stable across fresh Workflow runs. Core stores bind changes to immutable digests.
      const suiteId = `suite:${jobId}:frozen12`;
      const runId = `run:${jobId}:baseline`;
      let report;
      let evidence;
      let suiteDigest: string;
      await setJobState(jobId, 'planning');
      if (intake.package === 'text_eval') {
        const data = await api.advanceData();
        let suite;
        let dataProvenance;
        if (data !== null) {
          // All acquisition/review/cost/mapping/freeze gates remain distinct in the
          // private retained result. No nonready result can execute the target.
          if (data.status !== 'ready' || !data.frozen) {
            if (['waiting_for_data', 'waiting_for_review', 'cost_delivery_pending'].includes(data.status)) throw new TrackBPendingError(5000, 'Approved data is pending.');
            throw new TrackBBlockedError('needs_operator', 'Approved data requires reconciliation.');
          }
          const admitted = await api.approvedData(ctx, data.frozen.suite.digest);
          if (!admitted) throw new TrackBBlockedError('needs_operator', 'Approved suite admission unavailable.');
          suite = await api.text.getSuite(ctx, admitted.suite.digest);
          dataProvenance = admitted.provenance;
        } else {
          const designed = await api.text.designSuite(ctx, { suiteId, versionLabel: 'default',
            systemPrompt: intake.endpoint.systemPrompt || null, referenceText: intake.endpoint.referenceText ?? null });
          if (designed.status !== 'completed') {
            if (designed.agentOutcome?.status === 'pending') throw new TrackBPendingError(5000, 'Suite design pending.');
            if (designed.agentOutcome?.status === 'budget_paused' || designed.agentOutcome?.status === 'budget_exhausted') throw new TrackBBlockedError('paused_budget', 'Suite design budget paused.');
            throw new TrackBBlockedError('needs_operator', 'Suite design requires review.');
          }
          suite = designed.suite;
        }
        if (suite.scenarios.length !== 12) throw new TrackBBlockedError('needs_operator', 'Frozen scope differs from twelve scenarios.');
        const association = { runId, suiteDigest: suite.digest, scenarioIds: suite.scenarios.map(s => s.id) };
        await setJobState(jobId, 'running');
        await inventory.touch();
        const run = await inventory.phase(association, () => api.text.runSuite(ctx, { suiteDigest: suite.digest, runId }));
        await setJobState(jobId, 'investigating');
        await inventory.touch();
        const investigation = await inventory.phase(association, () => api.text.investigate(ctx, { suiteDigest: suite.digest, runId }));
        if (investigation.investigatorStatus === 'pending') throw new TrackBPendingError(5000, 'Investigation pending.');
        if (!['completed', 'skipped'].includes(investigation.investigatorStatus)) throw new TrackBBlockedError('needs_operator', 'Investigation requires reconciliation.');
        const input = await api.text.reportInput(ctx, { suiteDigest: suite.digest, runId });
        await api.bindTextBaseline(suite.digest, runId);
        // One deterministic confirmed objective finding per frozen12 job; saved evidence is resolved again by the service.
        const candidate = input.richFindings.find(f => f.label === 'confirmed' && f.evidence.some(e => e.kind === 'check' && run.executions.some(s => s.checks.some(c => c.checkId === e.checkId && c.kind === 'objective' && c.status === 'fail'))));
        const remediation = candidate ? await api.remediation.proposeAndVerifyFixDetailed(ctx, { findingId: candidate.id }) : null;
        const limitations = [...input.limitations, 'Remediation covers only the original frozen12. Appended packs remain separately gated.',
          'HTTP provider monetary amounts remain unknown until authoritative reconciliation; pending accounting holds remain reserved.',
          remediation ? `${remediation.remediation.verification.status}: ${remediation.reason} ${remediation.scope}` : 'No confirmed objective failure selected; no fix verified.'];
        report = await api.renderReport(ctx, { intake, findings: [], richFindings: input.richFindings, limitations });
        suiteDigest = suite.digest;
        evidence = { format: 'rich_text_remediation.v1', suite, run, investigation, remediation, dataProvenance: dataProvenance ?? null, limitations };
      } else {
        const suite = await api.calendar.freezeSuite(ctx, { suiteId });
        if (suite.scenarios.length !== 12) throw new TrackBBlockedError('needs_operator', 'Frozen scope differs from twelve scenarios.');
        const request = { suiteId, operationId: runId, versionLabel: 'default' };
        // The patched core factory binds a job-scoped aggregate runId to this operation.
        const association = { runId: calendarOperationRunId(jobId, request.operationId), suiteDigest: suite.hash,
          scenarioIds: suite.scenarios.map(s => s.id), branchId: api.branchId };
        await setJobState(jobId, 'running');
        await inventory.touch();
        const run = await inventory.phase(association, () => api.calendar.runSuite(ctx, request));
        await setJobState(jobId, 'investigating');
        await inventory.touch();
        const investigation = await inventory.phase(association, () => api.calendar.investigate(ctx, request));
        const input = await api.calendar.reportInput(ctx, request);
        if (input.status === 'needs_operator') throw new TrackBBlockedError('needs_operator', 'Calendar reproduction requires reconciliation.');
        const rendered = renderCalendarReport({ job, report: { ...input, limitations: [...input.limitations, 'Remediation not run; no fix verified.'] },
          generatedAt: suite.frozenAt, costs: null, knownSecrets: api.knownSecrets, includeHtml: true });
        report = Report.parse({ jobId, summary: rendered.summary, markdown: rendered.markdown, html: rendered.html ?? '', findings: input.findings });
        suiteDigest = suite.hash;
        evidence = { format: 'rich_calendar.v1', suite, run, investigation, limitations: input.limitations };
      }
      if (containsSecret(JSON.stringify({ evidence, report }), api.knownSecrets)) throw new TrackBBlockedError('needs_operator', 'Credential-bearing evidence refused.');
      await persistRichArtifact(workflowSql(), { jobId, tenantId: job.customerId, environment: job.environment }, suiteDigest, evidence, api.knownSecrets);
      await persistReportStep(jobId, report);
      await inventory.touch();
      } finally { await api.dispose(); }
    });
    return result.status === 'budget_exceeded' ? 'paused_budget' : 'complete';
  } catch (error) {
    if (!authorized) return 'needs_operator';
    const state: RichOutcome = error instanceof TrackBPendingError ? 'pending'
      : error instanceof TrackBBlockedError && error.code === 'paused_budget' ? 'paused_budget' : 'needs_operator';
    // Fixed prose only. Retain original checkpoint and reservations; never retry an
    // ambiguous dispatch with a fresh suite/run/branch identity.
    await recordProgress(jobId, `rich_${state}`, state === 'pending' ? 'Evaluation is pending on retained durable work.'
      : state === 'paused_budget' ? 'Evaluation paused at its budget limit.' : 'Evaluation requires operator reconciliation before continuing.');
    if (state === 'paused_budget') await setJobState(jobId, 'paused_budget');
    return state;
  }
}
richEvaluationStep.maxRetries = 0;

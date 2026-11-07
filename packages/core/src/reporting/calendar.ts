import { containsSecret } from '../agents/redact';
import { FindingSchema, type CostEntry, type JobRef } from '../evals/types';
import type { createCalendarEvaluationServices } from '../evals/calendar-integration';
import { renderReport } from './render';
import { canonicalJson } from '../evals/text/freeze';
import { z } from 'zod';

type CalendarReport = Awaited<ReturnType<ReturnType<typeof createCalendarEvaluationServices>['reportInput']>>;

/** Accept only the authorized durable service's rich report projection, not customer JSON.
 * Complete evidence stays in JSON; abbreviated findings never replace original runs. */
export function renderCalendarReport(input: {
  job: JobRef; report: CalendarReport; generatedAt: string;
  costs: CostEntry[] | null; knownSecrets?: readonly string[]; includeHtml?: boolean;
}) {
  const { job, report } = input;
  if (job.package !== 'workflow_eval' || report.suite.jobId !== job.jobId || report.run.jobId !== job.jobId
    || report.run.suiteHash !== report.suite.hash || report.investigation.original.runId !== report.run.runId
    || input.costs?.some(cost => cost.jobId !== job.jobId)) throw new Error('calendar_report_identity_mismatch');
  if (containsSecret(JSON.stringify({ job, report, costs: input.costs, generatedAt: input.generatedAt }), input.knownSecrets)) throw new Error('calendar_report_unsafe_evidence');
  if (!z.string().datetime({ offset: true }).safeParse(input.generatedAt).success) throw new Error('calendar_report_invalid_timestamp');
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  if (!same(report.findings, report.investigation.findings)) throw new Error('calendar_report_evidence_mismatch');
  for (const reproduction of report.investigation.reproductions) {
    const original = report.run.results.find(r => r.scenarioId === reproduction.originalScenarioId);
    if (!original || reproduction.result.scenarioId !== original.scenarioId || reproduction.result.scope.jobId !== job.jobId
      || reproduction.result.scope.version !== report.run.versionLabel || reproduction.result.scope.runId === original.scope.runId) {
      throw new Error('calendar_report_evidence_mismatch');
    }
  }
  const findings = report.findings.map(finding => {
    const original = report.run.results.find(r => r.scenarioId === finding.scenarioId);
    const reproductions = report.investigation.reproductions.filter(r => r.originalScenarioId === finding.scenarioId);
    const reproduction = reproductions[0]?.result;
    const failedChecks = (result: NonNullable<typeof original>) => (result.reason === 'false_success' ? result.claimGrade : result.stateGrade)?.results.filter(c => !c.passed).map(c => c.check);
    if (reproductions.length > 1 || finding.reproductions !== reproductions.length
      || !same(finding.association.reproductionScope ?? null, reproduction?.scope ?? null)
      || !same(finding.association.scope, original?.scope)
      || finding.status === 'confirmed' && (!original || !reproduction || original.outcome !== 'product_failure'
        || reproduction.outcome !== 'product_failure' || original.reason !== reproduction.reason
        || !failedChecks(original)?.length || !same(failedChecks(original), failedChecks(reproduction)))) {
      throw new Error('calendar_report_evidence_mismatch');
    }
    if (finding.association.jobId !== job.jobId || finding.association.suiteHash !== report.suite.hash
      || finding.association.branchId !== report.run.branchId
      || !report.run.results.some(result => result.scenarioId === finding.scenarioId && result.scope.runId === finding.association.scope.runId)) {
      throw new Error('calendar_report_identity_mismatch');
    }
    return FindingSchema.parse({
      id: finding.id, source: 'workflow_eval', category: finding.category, title: finding.title,
      label: finding.status, severity: finding.severity,
      basis: finding.category === 'state_mismatch' ? 'objective' : finding.category === 'false_success' ? 'heuristic' : 'unspecified',
      summary: finding.description, investigatorNote: null,
      evidence: finding.evidence.map(evidence => evidence.kind === 'state_diff'
        ? { kind: 'check', checkId: `${finding.scenarioId}:${evidence.location}`, detail: evidence.excerpt }
        : { kind: 'scenario_response', scenarioId: finding.scenarioId, runId: finding.association.scope.runId,
          quote: evidence.excerpt, truncated: true }),
      reproduction: { attempted: finding.reproductions > 0,
        reproduced: finding.status === 'confirmed' && finding.reproductions > 0 ? true : null,
        runId: finding.association.reproductionScope?.runId ?? null },
    });
  });
  // Recompute unresolved state from preserved evidence rather than trusting a caller's label.
  const status = report.investigation.pendingScenarioIds.length ? 'needs_operator'
    : report.run.results.some(r => r.outcome === 'inconclusive' || r.outcome === 'infrastructure_error')
      || report.investigation.reproductions.some(r => r.result.outcome === 'inconclusive' || r.result.outcome === 'infrastructure_error')
      || findings.some(f => f.label === 'inconclusive') ? 'unresolved' : 'completed';
  return renderReport({ job, generatedAt: input.generatedAt, findings, operatorSummary: null,
    costs: input.costs, limitations: report.limitations, includeHtml: input.includeHtml,
    evaluationStatus: status,
    details: { calendar: { suite: report.suite, run: report.run, investigation: report.investigation,
      monitoring: report.monitoring, status } },
  });
}

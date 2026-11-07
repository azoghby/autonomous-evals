import { verifyAdmittedFrozenSuite } from './freeze';
import { assertRunMatches } from './investigate';
import { SuiteRunSchema, type FrozenTextSuite, type SuiteRun } from './schema';

/** Structurally compatible with monitoring/MonitoringRun; subjective judgments never become objective regressions. */
export function textRunForMonitoring(suiteInput: FrozenTextSuite, runInput: SuiteRun, targetVersion: string): {
  jobId: string; runId: string; suiteDigest: string; targetVersion: string;
  checks: Array<{ scenarioId: string; checkId: string; outcome: 'passed' | 'failed' | 'inconclusive' | 'infrastructure_error'; evidenceIds: string[] }>;
} {
  const suite = verifyAdmittedFrozenSuite(suiteInput);
  const run = SuiteRunSchema.parse(runInput);
  assertRunMatches(suite, run);
  if (!targetVersion.trim()) throw new Error('target version required');
  return { jobId: run.jobId, runId: run.runId, suiteDigest: run.suiteDigest, targetVersion,
    checks: run.executions.flatMap(e => e.checks.map(c => ({ scenarioId: e.scenarioId, checkId: c.checkId,
      outcome: e.outcome === 'infrastructure_error' ? 'infrastructure_error' as const : c.kind === 'objective' && c.status === 'fail' ? 'failed' as const : c.status === 'pass' ? 'passed' as const : 'inconclusive' as const,
      evidenceIds: [`text:${run.runId}:${e.scenarioId}:${c.checkId}`],
    }))) };
}

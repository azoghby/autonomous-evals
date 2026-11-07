import { createHash } from 'node:crypto';
import { z } from 'zod';

const Check = z.object({
  scenarioId: z.string().min(1),
  checkId: z.string().min(1),
  outcome: z.enum(['passed', 'failed', 'inconclusive', 'infrastructure_error']),
  evidenceIds: z.array(z.string().min(1)),
}).strict();

export const MonitoringRun = z.object({
  jobId: z.string().min(1),
  runId: z.string().min(1),
  suiteDigest: z.string().regex(/^[a-f0-9]{64}$/),
  targetVersion: z.string().min(1),
  checks: z.array(Check).min(1),
}).strict();
export type MonitoringRun = z.infer<typeof MonitoringRun>;
export type MonitoringCheck = z.infer<typeof Check>;

/** Hash the exact persisted frozen suite bytes. Never re-generate a monitoring suite. */
export function frozenSuiteDigest(serializedSuite: string): string {
  if (!serializedSuite.length) throw new Error('Frozen suite must not be empty');
  return createHash('sha256').update(serializedSuite, 'utf8').digest('hex');
}

function index(run: MonitoringRun): Map<string, MonitoringCheck> {
  const entries = new Map<string, MonitoringCheck>();
  for (const check of run.checks) {
    const key = JSON.stringify([check.scenarioId, check.checkId]);
    if (entries.has(key)) throw new Error('Duplicate scenario/check identity');
    if ((check.outcome === 'passed' || check.outcome === 'failed') && !check.evidenceIds.length) {
      throw new Error('Definitive check results require evidence');
    }
    entries.set(key, check);
  }
  return entries;
}

export interface MonitoringComparison {
  baselineRunId: string;
  currentRunId: string;
  suiteDigest: string;
  regressions: Array<{ scenarioId: string; checkId: string; baselineEvidenceIds: string[]; currentEvidenceIds: string[] }>;
  improvements: Array<{ scenarioId: string; checkId: string }>;
  unresolved: Array<{ scenarioId: string; checkId: string; baseline: MonitoringCheck['outcome']; current: MonitoringCheck['outcome'] }>;
  /** Observations from a small frozen suite, not statistical significance. */
  interpretation: 'observed_changes_only';
}

export function compareMonitoringRuns(baselineInput: MonitoringRun, currentInput: MonitoringRun): MonitoringComparison {
  const baseline = MonitoringRun.parse(baselineInput);
  const current = MonitoringRun.parse(currentInput);
  if (baseline.jobId !== current.jobId || baseline.suiteDigest !== current.suiteDigest) {
    throw new Error('Monitoring runs must belong to the same authorized job and frozen suite');
  }
  if (baseline.runId === current.runId) throw new Error('Monitoring requires a distinct current run');
  const before = index(baseline);
  const after = index(current);
  if (before.size !== after.size || [...before.keys()].some((key) => !after.has(key))) {
    throw new Error('Monitoring runs must contain the same scenario/check identities');
  }
  const result: MonitoringComparison = {
    baselineRunId: baseline.runId, currentRunId: current.runId,
    suiteDigest: baseline.suiteDigest, regressions: [], improvements: [], unresolved: [],
    interpretation: 'observed_changes_only',
  };
  for (const [key, previous] of before) {
    const next = after.get(key)!;
    const identity = { scenarioId: next.scenarioId, checkId: next.checkId };
    if (previous.outcome === 'passed' && next.outcome === 'failed') {
      result.regressions.push({ ...identity, baselineEvidenceIds: [...previous.evidenceIds], currentEvidenceIds: [...next.evidenceIds] });
    } else if (previous.outcome === 'failed' && next.outcome === 'passed') {
      result.improvements.push(identity);
    } else if (['inconclusive', 'infrastructure_error'].includes(previous.outcome) || ['inconclusive', 'infrastructure_error'].includes(next.outcome)) {
      result.unresolved.push({ ...identity, baseline: previous.outcome, current: next.outcome });
    }
  }
  return result;
}

/** Draft only. Track A owns authenticated scheduling, subscriptions, and delivery. */
export function monitoringAlertDraft(comparison: MonitoringComparison): { subject: string; text: string } | null {
  if (!comparison.regressions.length) return null;
  const count = comparison.regressions.length;
  return {
    subject: `Evaluation monitoring: ${count} observed regression${count === 1 ? '' : 's'}`,
    text: `${count} previously passing check${count === 1 ? '' : 's'} failed on the frozen evaluation suite. Review the authenticated report for evidence and reproduction details. These are observed differences, not a statistical significance claim.${comparison.unresolved.length ? ` ${comparison.unresolved.length} other check comparisons remain unresolved.` : ''}`,
  };
}

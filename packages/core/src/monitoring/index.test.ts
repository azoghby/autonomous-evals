import { describe, expect, it } from 'vitest';
import { compareMonitoringRuns, frozenSuiteDigest, monitoringAlertDraft, type MonitoringRun } from './index';

const digest = frozenSuiteDigest('{"scenarios":["s1"]}');
const run = (id: string, outcome: MonitoringRun['checks'][number]['outcome']): MonitoringRun => ({
  jobId: 'job1', runId: id, suiteDigest: digest, targetVersion: id,
  checks: [{ scenarioId: 's1', checkId: 'c1', outcome, evidenceIds: [`evidence-${id}`] }],
});

describe('frozen-suite monitoring', () => {
  it('preserves before/after evidence and does not mutate the baseline', () => {
    const baseline = run('before', 'passed');
    const snapshot = JSON.stringify(baseline);
    const result = compareMonitoringRuns(baseline, run('after', 'failed'));
    expect(result.regressions).toEqual([{ scenarioId: 's1', checkId: 'c1', baselineEvidenceIds: ['evidence-before'], currentEvidenceIds: ['evidence-after'] }]);
    expect(JSON.stringify(baseline)).toBe(snapshot);
    expect(monitoringAlertDraft(result)?.text).toContain('not a statistical significance claim');
  });
  it.each(['infrastructure_error', 'inconclusive'] as const)('does not turn %s into a regression', (outcome) => {
    const result = compareMonitoringRuns(run('before', 'passed'), run('after', outcome));
    expect(result.regressions).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(monitoringAlertDraft(result)).toBeNull();
  });
  it('does not count failure after an unresolved baseline as a new regression', () => {
    expect(compareMonitoringRuns(run('before', 'inconclusive'), run('after', 'failed')).regressions).toHaveLength(0);
  });
  it('reports improvements without issuing regression alerts', () => {
    const result = compareMonitoringRuns(run('before', 'failed'), run('after', 'passed'));
    expect(result.improvements).toHaveLength(1);
    expect(monitoringAlertDraft(result)).toBeNull();
  });
  it('rejects different jobs, changed suites, and reused runs', () => {
    const before = run('before', 'passed');
    expect(() => compareMonitoringRuns(before, { ...run('after', 'failed'), jobId: 'other' })).toThrow();
    expect(() => compareMonitoringRuns(before, { ...run('after', 'failed'), suiteDigest: frozenSuiteDigest('changed') })).toThrow();
    expect(() => compareMonitoringRuns(before, run('before', 'failed'))).toThrow();
  });
  it('rejects missing, duplicate, or changed check identities', () => {
    const current = run('after', 'failed');
    expect(() => compareMonitoringRuns(run('before', 'passed'), { ...current, checks: [] })).toThrow();
    expect(() => compareMonitoringRuns(run('before', 'passed'), { ...current, checks: [...current.checks, ...current.checks] })).toThrow();
    expect(() => compareMonitoringRuns(run('before', 'passed'), { ...current, checks: [{ ...current.checks[0], checkId: 'other' }] })).toThrow();
  });
  it('requires evidence for definitive outcomes', () => {
    const current = run('after', 'failed');
    expect(() => compareMonitoringRuns(run('before', 'passed'), { ...current, checks: [{ ...current.checks[0], evidenceIds: [] }] })).toThrow();
  });
});

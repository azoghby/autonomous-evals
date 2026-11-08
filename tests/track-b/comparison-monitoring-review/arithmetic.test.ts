/** Independent review: explicit local fixtures; no provider, network, cloud or message calls. */
import { describe, expect, it } from 'vitest';
import { compareRichChecks, richChecks, type RichCheck, type RichOutcome, type RichRunArtifact } from '../src/monitoring';
import { calendarAcceptanceScenarios } from '../src/simulator/acceptance-scenarios';
import { freezeCalendarSuite } from '../src/simulator/workflow';

const check = (index: number, outcome: RichOutcome): RichCheck => ({ scenarioId: `local-${index}`, checkId: 'objective', outcome, evidenceIds: [`fixture-evidence-${index}`] });
const statuses: RichOutcome[] = ['passed', 'failed', 'rubric_concern', 'not_assessed', 'inconclusive', 'infrastructure_error', 'check_error'];

describe('Acceptance: independent scope and arithmetic oracle', () => {
  it('accounts for every outcome pair without labeling infrastructure or unassessed evidence a regression', () => {
    const pairs = statuses.flatMap(left => statuses.map(right => [left, right] as const));
    const baseline = pairs.map(([left], i) => check(i, left));
    const current = pairs.map(([, right], i) => check(i, right));
    const r = compareRichChecks(baseline, current);
    expect(r.totalChecks).toBe(49);
    expect(r.pairedAssessed).toBe(4);
    expect(r.unresolved).toHaveLength(45);
    expect(r.changes).toHaveLength(42);
    expect(r.regressions).toHaveLength(1);
    expect(r.improvements).toHaveLength(1);
    expect(r.passRateDelta).toBe(0);
    expect(Object.values(r.baselineCounts).reduce((a, b) => a + b, 0)).toBe(49);
    for (const s of statuses) { expect(r.baselineCounts[s]).toBe(7); expect(r.currentCounts[s]).toBe(7); }
  });
  it('uses the same assessed pairs for numerator and denominator, and preserves zero versus unknown', () => {
    const r = compareRichChecks([check(0, 'failed'), check(1, 'passed'), check(2, 'passed'), check(3, 'failed')],
      [check(0, 'passed'), check(1, 'passed'), check(2, 'infrastructure_error'), check(3, 'not_assessed')]);
    expect(r.pairedAssessed).toBe(2); expect(r.passRateDelta).toBe(0.5);
    expect(compareRichChecks([check(0, 'passed')], [check(0, 'passed')]).passRateDelta).toBe(0);
    expect(compareRichChecks([check(0, 'infrastructure_error')], [check(0, 'passed')]).passRateDelta).toBeNull();
  });
  it('rejects dropped, appended, duplicate and ungrounded check identities', () => {
    const a = [check(0, 'passed'), check(1, 'passed')];
    expect(() => compareRichChecks(a, a.slice(0, 1))).toThrow();
    expect(() => compareRichChecks(a, [...a, check(2, 'passed')])).toThrow();
    expect(() => compareRichChecks(a, [a[0], a[0]])).toThrow();
    expect(() => compareRichChecks(a, [a[0], { ...a[1], evidenceIds: [] }])).toThrow();
  });
});

function calendarArtifact(): Extract<RichRunArtifact, { kind: 'calendar' }> {
  const suite = freezeCalendarSuite({ jobId: 'local-review-calendar', frozenAt: '2026-11-07T20:00:00Z', origin: 'internal_fixture', review: { reviewerId: 'local-reviewer', approved: true },
    scenarios: calendarAcceptanceScenarios().map(({ id, prompt, actorId, seed, checks }) => structuredClone({ id, prompt, actorId, seed, checks })) });
  return { kind: 'calendar', suite, investigation: { fixture: true }, limitations: ['Synthetic boundary fixture; not execution evidence.'], costs: [], unknownCosts: ['Fixture only.'],
    run: { jobId: suite.jobId, branchId: 'fixture-branch', runId: 'fixture-run', suiteHash: suite.hash, versionLabel: 'fixture-version', origin: 'internal_fixture',
      results: suite.scenarios.map((s, i) => {
        const scope = { jobId: suite.jobId, runId: `fixture-scope-${i}`, version: 'fixture-version' };
        return { scenarioId: s.id, scope, outcome: 'passed', reason: 'sql_checks_passed', stateGrade: { passed: true, results: s.checks.map(check => ({ check, passed: true })) },
          execution: { scenarioId: s.id, scope, messages: [{ role: 'assistant', content: 'Explicit local fixture.' }], state: structuredClone(s.seed), stopped: 'complete', rounds: 1 } };
      }) } };
}

describe('Regression: contradictory calendar evidence is rejected', () => {
  it('rejects passes when retained SQL grades failed', () => {
    const a = calendarArtifact();
    for (const r of a.run.results) { r.stateGrade!.passed = false; r.stateGrade!.results.forEach(c => { c.passed = false; }); }
    expect(() => richChecks(a)).toThrow();
  });
  it('rejects target infrastructure stops labeled as passes with stale grades', () => {
    const a = calendarArtifact(); a.run.results.forEach(r => { r.execution!.stopped = 'target_error'; });
    expect(() => richChecks(a)).toThrow();
  });
  it('rejects definitive calendar passes without expected SQL check evidence', () => {
    const a = calendarArtifact(); a.run.results.forEach(r => { r.stateGrade!.results = []; });
    expect(() => richChecks(a)).toThrow();
  });
  it('rejects unsupported product failures with passing grades', () => {
    const a = calendarArtifact(); const before = richChecks(a);
    a.run.results[0].outcome = 'product_failure'; a.run.results[0].reason = 'sql_checks_passed';
    expect(() => compareRichChecks(before, richChecks(a))).toThrow();
  });
});

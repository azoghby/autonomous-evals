import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparePaired, summarizeRepeats, wilson95 } from '../../../packages/core/src/evals/sandbox/grading/statistics.js';
import type { StatisticalTrial } from '../../../packages/core/src/evals/sandbox/grading/statistics.js';

const versions = { spec: 'sandbox-spec-v1' as const, suiteHash: 'suite', simulatorModel: 'sim', judgeModel: 'judge', envHash: 'env', runtime: 'runtime' };
function trial(n: number, status: StatisticalTrial['status'] = 'pass', extras: Partial<StatisticalTrial> = {}): StatisticalTrial {
  return { scenarioId: 'sx_refund', trial: n, seed: `seed${n}`, fixtureHash: 'fixture', variant: 'default', agentVersion: 'A', versions, status, ...(status === 'fail' ? { failureAttribution: 'agent' as const } : {}), ...extras };
}
function close(actual: number, expected: number): void { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`); }

test('Wilson numeric small samples, extremes, and absent denominator', () => {
  assert.equal(wilson95(0, 0), null);
  const zero = wilson95(0, 1)!;
  close(zero[0], 0); close(zero[1], 0.7934506856227626);
  const one = wilson95(1, 1)!;
  close(one[0], 0.20654931437723745); close(one[1], 1);
  const half = wilson95(1, 2)!;
  close(half[0], 0.09453120573423074); close(half[1], 0.9054687942657693);
  assert.throws(() => wilson95(2, 1));
  assert.throws(() => wilson95(0.5, 1));
});

test('observed all-k is conjunction, not passRate to power k', () => {
  const result = summarizeRepeats([trial(0), trial(1, 'fail')], 2);
  assert.equal(result.passRate, 0.5);
  assert.equal(result.allK, false);
  assert.equal(summarizeRepeats([trial(0), trial(1)], 2).allK, true);
  assert.equal(summarizeRepeats([trial(0)], 2).allK, null);
  assert.equal(summarizeRepeats([], 2).passRate, null);
});

test('attribution exclusions preserve denominators and cannot make incomplete repeats reliable', () => {
  const result = summarizeRepeats([
    trial(0), trial(1, 'fail'),
    trial(2, 'fail', { failureAttribution: 'simulator' }),
    trial(3, 'fail', { failureAttribution: 'environment' }),
    trial(4, 'fail', { failureAttribution: 'grader' }),
    trial(5, 'unknown'), trial(6, 'fail', { failureAttribution: undefined }),
  ], 8);
  assert.deepEqual(result.excluded, { simulator: 1, environment: 1, grader: 1, unknown: 2 });
  assert.equal(result.observed, 7); assert.equal(result.missing, 1); assert.equal(result.eligible, 2);
  assert.equal(result.passRate, 0.5); assert.equal(result.agentFailures, 1); assert.equal(result.allK, null);
});

test('repeats reject identity drift, duplicate IDs, and malformed attribution', () => {
  assert.throws(() => summarizeRepeats([trial(0), trial(0)], 2));
  assert.throws(() => summarizeRepeats([trial(0), trial(1, 'pass', { versions: { ...versions, judgeModel: 'changed' } })], 2));
  assert.throws(() => summarizeRepeats([trial(0), trial(1, 'pass', { agentVersion: 'B' })], 2));
  assert.throws(() => summarizeRepeats([trial(0, 'pass', { failureAttribution: 'agent' })], 1));
  assert.throws(() => summarizeRepeats([], 0));
});

test('paired differences are seed/version/fixture matched and small samples stay uncertain', () => {
  const a = [trial(0, 'fail'), trial(1)];
  const b = [trial(1, 'fail', { agentVersion: 'B' }), trial(0, 'pass', { agentVersion: 'B' })];
  const result = comparePaired(a, b);
  assert.equal(result.delta, 0); assert.equal(result.matchedPairs, 2); assert.equal(result.eligiblePairs, 2);
  assert.deepEqual(result.ci95, [-1, 1]); assert.equal(result.improvement, false);
  const mismatch = comparePaired([trial(0)], [trial(0, 'pass', { seed: 'different', agentVersion: 'B' })]);
  assert.equal(mismatch.matchedPairs, 0); assert.equal(mismatch.unmatchedLeft, 1); assert.equal(mismatch.unmatchedRight, 1); assert.equal(mismatch.delta, null);
  const fixtureMismatch = comparePaired([trial(0)], [trial(0, 'pass', { fixtureHash: 'different', agentVersion: 'B' })]);
  assert.equal(fixtureMismatch.eligiblePairs, 0);
  assert.throws(() => comparePaired(a, [trial(0, 'pass', { versions: { ...versions, runtime: 'changed' } })]));
  assert.throws(() => comparePaired([trial(0), trial(0)], []));
  assert.throws(() => comparePaired([trial(0), trial(0, 'pass', { seed: 'changed' })], []));
});

test('paired exclusions and scenario clustering prevent repeated seeds becoming independent scenarios', () => {
  const a = [trial(0, 'fail'), trial(1, 'fail'), trial(2, 'unknown')];
  const b = [trial(0), trial(1), trial(2)];
  const result = comparePaired(a, b);
  assert.equal(result.matchedPairs, 3); assert.equal(result.eligiblePairs, 2); assert.equal(result.excludedPairs, 1);
  assert.equal(result.independentScenarioClusters, 1); assert.equal(result.delta, 1);
  assert.equal(result.improvement, false);
  const manyA = Array.from({ length: 20 }, (_, n) => trial(0, 'fail', { scenarioId: `sx_case${n}` }));
  const manyB = manyA.map(value => ({ ...value, agentVersion: 'B', status: 'pass' as const, failureAttribution: undefined }));
  const many = comparePaired(manyA, manyB);
  close(many.ci95![0], 1 - Math.sqrt(2 * Math.log(40) / 20));
  assert.equal(many.improvement, true);
});

import { expect, it } from 'vitest';
import { qualityOutcome } from '../../../packages/core/src/evals/sandbox/integration/outcome';
import type { TrialArtifact } from '../../../packages/core/src/evals/sandbox/execution/runner';
import type { GradeResult } from '../../../packages/core/src/evals/sandbox/grading';

const execution = () => ({ status: 'completed', infrastructure: 'known', money: { status: 'unknown', microUsd: null } }) as TrialArtifact;
const grade = () => ({ verdict: 'pass', checks: [{ rewardBearing: true, verdict: 'pass' }] }) as GradeResult;
it('separates complete quality from unknown money and applies only explicit approved cost caps', () => {
  const e = execution(), g = grade(), reasons: string[] = [];
  expect(qualityOutcome(e, g, null, reasons)).toBe('pass');
  expect(e.money.microUsd).toBeNull(); expect(reasons).toEqual([]);
  expect(qualityOutcome(e, g, {version:'sandbox-quality-cost-policy-v1',maxCostMicroUsd:100}, reasons)).toBe('unknown');
  expect(reasons).toEqual(['cost_unsettled']);
});
it('invalid monetary telemetry and incomplete execution cannot pass even without a cap', () => {
  for (const cost of [-1, 1.5, NaN, Infinity]) {
    const e = execution(); (e.money as {microUsd:number|null}).microUsd = cost;
    const reasons: string[] = [];
    expect(qualityOutcome(e, grade(), null, reasons)).toBe('unknown'); expect(reasons).toContain('cost_invalid');
  }
  for (const patch of [{status:'unresolved'}, {infrastructure:'unknown'}])
    expect(qualityOutcome({...execution(), ...patch} as TrialArtifact, grade(), null, [])).toBe('unknown');
});
it('incomplete reward evidence remains unknown even when another check fails', () => {
  const g = grade(); g.verdict = 'fail'; g.checks.push({...g.checks[0], verdict:'unknown'});
  expect(qualityOutcome(execution(), g, null, [])).toBe('unknown');
  g.checks.pop(); expect(qualityOutcome(execution(), g, null, [])).toBe('fail');
  expect(qualityOutcome(execution(), g, null, ['media_perception_unresolved_or_failed'])).toBe('unknown');
});

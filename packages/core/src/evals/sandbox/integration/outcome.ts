import type { GradeResult } from '../grading';
import type { TrialArtifact } from '../execution/runner';
import type { GateQualityCostPolicy } from '../generation/gates';

export const SANDBOX_OUTCOME_RULE = 'sandbox-quality-outcome-v2' as const;

/** Quality and accounting are independent. Only a trusted approved customer policy
 * turns measured cost into a quality gate. No failure attribution is inferred here. */
export function qualityOutcome(execution: TrialArtifact, grade: GradeResult | null,
  policy: GateQualityCostPolicy | null, unresolved: string[]): 'pass' | 'fail' | 'unknown' {
  const cost = execution.money.microUsd;
  if (cost !== null && (!Number.isSafeInteger(cost) || cost < 0)) unresolved.push('cost_invalid');
  if (policy && cost === null) unresolved.push('cost_unsettled');
  // A failing check must not hide incomplete SQL/security/perception evidence.
  if (!grade || grade.verdict === 'unknown' || grade.checks.some(c => c.rewardBearing && c.verdict === 'unknown'))
    unresolved.push('grading_unknown');
  if (execution.status !== 'completed' || execution.infrastructure !== 'known') unresolved.push('execution_incomplete');
  if (unresolved.length) return 'unknown';
  if (grade!.verdict === 'fail' || (policy && cost !== null && cost > policy.maxCostMicroUsd)) return 'fail';
  return 'pass';
}

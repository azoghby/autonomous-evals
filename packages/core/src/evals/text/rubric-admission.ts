import { sentences, supportedInstructionContext } from './admission';
import type { FrozenTextSuiteBody, RubricCheck, TextScenario } from './schema';

/** Separate from objective grammar/version: task identity changes without migrating catalogs. */
export const RUBRIC_ADMISSION_VERSION = 'reference_assessment.v3';
export function conditionalResponses(systemPrompt: string | null) {
  // Deliberately narrow, source-bound grammar. Never infer an arbitrary condition's meaning.
  // Candidates retain offsets even in opaque context. Admission separately checks authority;
  // copying a candidate binding cannot lift unresolved scope or conflict quarantine.
  return sentences(systemPrompt ?? '').flatMap(s => {
    const match = /^When the reference does not contain an answer, say ("(?:[^"\\]|\\.)+")\.?$/.exec(s.quote);
    if (!match) return [];
    try {
      const response: unknown = JSON.parse(match[1]!);
      return typeof response === 'string' ? [{ ...s, id: `systemPrompt:all:${s.start}`, response }] : [];
    } catch { return []; }
  });
}
export type ConditionalResponse = ReturnType<typeof conditionalResponses>[number];
export function conditionalRubric(rule: ConditionalResponse): string {
  return `Apply source instruction verbatim: ${rule.quote} Conditional applicability requires reference judgment; when applicable the entire response must equal ${JSON.stringify(rule.response)}. No paraphrase or additional text is allowed.`;
}
/** Positive, bounded support only: an entire authoritative source must be this instruction.
 * Do not mine quotations, examples, conditions, or arbitrary rubric prose for semantics.
 */
export function behavioralInstructions(systemPrompt: string | null, scenario: Pick<TextScenario, 'id' | 'userMessage'>) {
  return ([['systemPrompt', 'all', systemPrompt], ['userMessage', scenario.id, scenario.userMessage]] as const)
    .flatMap(([source, scope, text]) => {
      if (source === 'userMessage' && systemPrompt?.trim() && systemPrompt !== text) return [];
      if (text !== 'Use a polite tone.' && text !== 'Use a clear, professional tone.') return [];
      return [{ id: `${source}:${scope}:0`, quote: text }];
    });
}
export function behavioralRubric(instruction: { quote: string }): string {
  return `Judge only the response's tone under this source instruction: ${instruction.quote} Do not assess factual correctness, reference coverage, source absence, fabrication, or answer usefulness.`;
}
function supportedBehavior(check: RubricCheck, systemPrompt: string | null, scenario: TextScenario): boolean {
  return behavioralInstructions(systemPrompt, scenario).some(r => r.id === check.behavioralInstructionId
    && check.rubric === behavioralRubric(r)) && !check.assessesFactualCorrectness
    && !check.requiresReference && check.conditionalInstructionId === undefined;
}
export function bindRubricReferences(scenarios: readonly TextScenario[], systemPrompt: string | null = null): TextScenario[] {
  // No semantic inference from an agent's false flag. Only exact code templates are exempt.
  return scenarios.map(s => ({ ...s, rubricChecks: s.rubricChecks.map(c => supportedBehavior(c, systemPrompt, s)
    ? { ...c } : { ...c, requiresReference: true as const }) }));
}
/** New drafts only; frozen checks are never repaired. Known source IDs identify code-owned
 * slots. Unknown IDs and ordinary factual/behavioral checks are preserved for validation. */
export function constructConditionalChecks(scenarios: readonly TextScenario[], systemPrompt: string | null): TextScenario[] {
  const rules = conditionalResponses(systemPrompt);
  return scenarios.map(s => {
    const checks = s.rubricChecks.filter(c => !rules.some(r => r.id === c.conditionalInstructionId));
    for (const rule of rules) {
      let n = 1;
      while (checks.some(c => c.id === `${s.id}.r${n}`)) n++;
      checks.push({ id: `${s.id}.r${n}`, kind: 'rubric', description: 'Source-bound exact conditional response',
        rubric: conditionalRubric(rule), conditionalInstructionId: rule.id,
        assessesFactualCorrectness: true, requiresReference: true });
    }
    return { ...s, rubricChecks: checks };
  });
}

export function rubricAdmissionProblems(input: Pick<FrozenTextSuiteBody, 'systemPrompt' | 'referenceText' | 'scenarios'>): string[] {
  const rules = conditionalResponses(input.systemPrompt);
  const problems: string[] = [];
  if (rules.length && (!supportedInstructionContext(input.systemPrompt ?? '')
    || new Set(rules.map(r => r.response)).size > 1)) {
    problems.push('conditional source scope or conflict unresolved; candidate text is not an authoritative executable rule');
  }
  for (const scenario of input.scenarios) {
    for (const check of scenario.rubricChecks) {
      if (check.behavioralInstructionId !== undefined && !supportedBehavior(check, input.systemPrompt, scenario)) {
        problems.push(`${check.id}: behavioral source/assessment binding differs from authoritative instruction`);
      }
      if ((rules.length || behavioralInstructions(input.systemPrompt, scenario).length || check.requiresReference) && !check.assessesFactualCorrectness && !supportedBehavior(check, input.systemPrompt, scenario)) {
        problems.push(`${check.id}: reference-scoped assessment must be factual (including reference absence/no fabrication)`);
      }
      if (check.conditionalInstructionId !== undefined) {
        const rule = rules.find(r => r.id === check.conditionalInstructionId);
        if (!rule || check.rubric !== conditionalRubric(rule) || !check.assessesFactualCorrectness) {
          problems.push(`${check.id}: conditional response binding/template differs from authoritative instruction`);
        }
      }
    }
    for (const rule of rules) {
      if (!scenario.rubricChecks.some(c => c.conditionalInstructionId === rule.id && c.rubric === conditionalRubric(rule) && c.assessesFactualCorrectness)) {
        problems.push(`${scenario.id}: missing source-bound conditional response ${rule.id}; preserve exact wording separately from applicability`);
      }
    }
  }
  return problems;
}
export function conditionalRuleFor(check: RubricCheck, systemPrompt: string | null) {
  return conditionalResponses(systemPrompt).find(r => r.id === check.conditionalInstructionId);
}

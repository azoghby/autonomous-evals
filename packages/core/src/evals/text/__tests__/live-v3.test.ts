import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyAdmittedFrozenSuite } from '../freeze';
import { evaluateObjectiveCheck } from '../objective';
import { executeScenario } from '../execute';
import type { TextExecutionDeps } from '../schema';

// Actual completed Naive design/review artifact. Execution below is offline;
// injected judgments exercise code enforcement, not model correctness.
const artifact = JSON.parse(readFileSync(new URL('./evidence/text-design-v3-2026-11-07.json', import.meta.url), 'utf8'));
const suite = verifyAdmittedFrozenSuite(artifact.outcome.suite);

describe('actual v3 live-designed frozen suite', () => {
  it('retains the original immutable digest and twelve reviewed scenarios', () => {
    expect(suite.digest).toBe('0e5d6df16cd4c5953bb3a0966cf410216690549d3393cf60150d30b711a942e9');
    expect(suite.scenarios).toHaveLength(12);
    expect(artifact.sessions.map((s: { state: string }) => s.state)).toEqual(['completed', 'completed']);
    expect(artifact.validationScope.measuredSessionMicroUsd).toBe(129924);
  });
  it.each(suite.scenarios)('$id preserves limits, paraphrases and separate factual assessment', scenario => {
    const word = scenario.objectiveChecks.find(c => c.spec.type === 'max_words')!;
    const token = scenario.objectiveChecks.find(c => c.spec.type === 'not_contains')!;
    expect(word.spec).toEqual({ type: 'max_words', value: 50 });
    expect(evaluateObjectiveCheck(word, Array(51).fill('word').join(' ')).status).toBe('fail');
    expect(evaluateObjectiveCheck(token, 'INTERNAL_ONLY').status).toBe('fail');
    for (const check of scenario.objectiveChecks) expect(evaluateObjectiveCheck(check, 'The basic plan permits three projects.').status).toBe('pass');
    expect(scenario.rubricChecks.filter(c => c.conditionalInstructionId)).toHaveLength(1);
    expect(scenario.rubricChecks.some(c => !c.conditionalInstructionId && c.assessesFactualCorrectness && c.requiresReference)).toBe(true);
  });
  it.each([
    ['Not specified in the reference.', 'pass'],
    ['The reference does not specify pricing.', 'concern'],
    ['Not specified in the reference. It costs $10.', 'concern'],
  ])('enforces actual S09 exact fallback after injected applicability: %s', async (response, expected) => {
    const deps: TextExecutionDeps = {
      target: { send: async () => ({ ok: true, text: response, latencyMs: 0 }) },
      judge: async () => ({ outcome: 'passed', explanation: 'Offline applicability fixture', evidenceQuotes: [] }),
      evaluateObjective: evaluateObjectiveCheck,
    };
    const execution = await executeScenario(suite, 'S09', 'live_v3_offline_probe', 'initial', deps);
    const conditional = suite.scenarios.find(s => s.id === 'S09')!.rubricChecks.find(c => c.conditionalInstructionId)!;
    expect(execution.checks.find(c => c.checkId === conditional.id)?.status).toBe(expected);
  });
});

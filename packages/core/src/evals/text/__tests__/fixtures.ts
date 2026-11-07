import { freezeSuite } from '../freeze';
import type { FrozenTextSuite, FrozenTextSuiteBody, TextScenario } from '../schema';

/** Internal fixtures only: no customer endpoint, credentials, or provider calls. */
export function makeScenarios(): TextScenario[] {
  return Array.from({ length: 12 }, (_, i): TextScenario => {
    const id = `S${String(i + 1).padStart(2, '0')}`;
    return {
      id, title: `Fixture ${i + 1}`, category: i < 4 ? 'ordinary' : i < 8 ? 'instruction_edge' : 'grounding_ambiguity',
      userMessage: 'The response must contain the literal "READY".\nThe response must not contain the literal "FORBIDDEN_MARKER".', rationale: 'Checks the explicit reply constraint.', severity: 'medium',
      objectiveChecks: [{ id: `${id}.o1`, kind: 'objective', description: 'Includes required marker', spec: { type: 'contains', value: 'READY', case_sensitive: true } }],
      rubricChecks: [],
    };
  });
}

export function makeSuite(overrides: Partial<FrozenTextSuiteBody> = {}): FrozenTextSuite {
  return freezeSuite({
    schemaVersion: 'text_suite.v1', jobId: 'fixture-text', versionLabel: 'fixture-v1', frozenAt: '2026-11-07T20:00:00.000Z',
    systemPrompt: 'Follow the explicit user constraints.', referenceText: null, scenarios: makeScenarios(),
    review: { sessions: [
      { role: 'evaluation_engineer', purpose: 'text_design', taskKey: 'fixture-design', sessionId: 'fixture-engineer' },
      { role: 'quality_investigator', purpose: 'text_review', taskKey: 'fixture-review', sessionId: 'fixture-investigator' },
    ], rejections: [], reductions: [] },
    ...overrides,
  });
}

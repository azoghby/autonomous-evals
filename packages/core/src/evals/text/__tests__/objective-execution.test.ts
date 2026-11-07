import { describe, expect, it, vi } from 'vitest';
import { executeScenario, executeSuite, executionVerdict, executionGaps } from '../execute';
import { canonicalSuiteJson, freezeSuite, verifyFrozenSuite } from '../freeze';
import { evaluateObjectiveCheck, MAX_REGEX_INPUT_CHARS } from '../objective';
import type { ObjectiveCheck, ObjectiveSpec, TextExecutionDeps } from '../schema';
import { makeScenarios, makeSuite } from './fixtures';

const check = (spec: ObjectiveSpec): ObjectiveCheck => ({ id: 'S01.o1', kind: 'objective', description: 'Fixture constraint', spec });
const score = (spec: ObjectiveSpec, response: string) => evaluateObjectiveCheck(check(spec), response);
const deps = (overrides: Partial<TextExecutionDeps> = {}): TextExecutionDeps => ({
  target: { send: async () => ({ ok: true, text: 'READY', latencyMs: 1 }) },
  judge: null, evaluateObjective: evaluateObjectiveCheck, ...overrides,
});
const rubricSuite = (factual = false) => {
  const scenarios = makeScenarios();
  scenarios[0] = { ...scenarios[0]!, objectiveChecks: [], rubricChecks: [{ id: 'S01.r1', kind: 'rubric', description: 'Quality rubric', rubric: 'Assess the response against the supplied reference.', assessesFactualCorrectness: factual }] };
  return makeSuite({ scenarios });
};

describe('deterministic objective constraints', () => {
  it.each([
    [{ type: 'contains', value: 'Ready', case_sensitive: false }, 'READY', 'pass'],
    [{ type: 'contains', value: 'Ready', case_sensitive: true }, 'READY', 'fail'],
    [{ type: 'not_contains', value: 'unsafe', case_sensitive: false }, 'UNSAFE action', 'fail'],
    [{ type: 'contains_any', values: ['yes', 'ready'], case_sensitive: false }, 'READY', 'pass'],
    [{ type: 'max_chars', value: 1 }, '😀', 'pass'],
    [{ type: 'min_chars', value: 2 }, '😀', 'fail'],
    [{ type: 'max_words', value: 2 }, 'one\t two\nthree', 'fail'],
    [{ type: 'max_lines', value: 2 }, 'one\r\ntwo\n', 'pass'],
    [{ type: 'json_valid' }, '```json\n{"a":1}\n```', 'pass'],
    [{ type: 'json_valid' }, 'Here is JSON: {"a":1}', 'fail'],
    [{ type: 'json_has_keys', keys: ['a'] }, '{"a":null}', 'pass'],
    [{ type: 'json_has_keys', keys: ['toString'] }, '{}', 'fail'],
    [{ type: 'json_has_keys', keys: ['a'] }, '[{"a":1}]', 'fail'],
    [{ type: 'regex_match', pattern: '^READY$', flags: 'i' }, 'ready', 'error'],
    [{ type: 'regex_absent', pattern: 'bad', flags: '' }, 'bad', 'error'],
  ] as Array<[ObjectiveSpec, string, string]>)('checks %j', (spec, response, status) => {
    const first = score(spec, response);
    expect(first.status).toBe(status);
    expect(score(spec, response)).toEqual(first);
    expect(first.evidenceQuotes.every((quote) => response.includes(quote))).toBe(true);
  });

  it('keeps exact Unicode and CRLF evidence despite normalization', () => {
    const response = 'İSTANBUL\r\nREADY 😀';
    const result = score({ type: 'contains', value: 'i̇stanbul\nready', case_sensitive: false }, response);
    expect(result.status).toBe('pass');
    expect(result.evidenceQuotes).toEqual(['İSTANBUL\r\nREADY']);
  });

  it('treats malformed and unbounded regex checks as test defects', () => {
    const malformed = { type: 'regex_match', pattern: '(a+)+', flags: '' } as ObjectiveSpec;
    expect(score(malformed, 'aaaa!')).toMatchObject({ status: 'error', reason: 'check_error' });
    expect(score({ type: 'regex_match', pattern: 'x', flags: '' }, 'x'.repeat(MAX_REGEX_INPUT_CHARS + 1))).toMatchObject({ status: 'error', reason: 'check_error' });
  });
});

describe('frozen suite and target execution', () => {
  it('verifies digest after JSON persistence and rejects prompt or check tampering', () => {
    const suite = makeSuite();
    expect(verifyFrozenSuite(JSON.parse(JSON.stringify(suite)))).toEqual(suite);
    expect(() => verifyFrozenSuite({ ...suite, systemPrompt: 'changed' })).toThrow();
    const changed = structuredClone(suite);
    changed.scenarios[0]!.objectiveChecks[0]!.description = 'changed';
    expect(() => verifyFrozenSuite(changed)).toThrow();
    const { digest: _, ...body } = suite;
    expect(freezeSuite(JSON.parse(canonicalSuiteJson(body))).digest).toBe(suite.digest);
  });

  it('rejects short suites, duplicate identities, and missing category coverage before freeze', () => {
    const scenarios = makeScenarios();
    expect(() => makeSuite({ scenarios: scenarios.slice(0, 11) })).toThrow();
    const duplicate = [...scenarios]; duplicate[1] = duplicate[0]!;
    expect(() => makeSuite({ scenarios: duplicate })).toThrow();
    expect(() => makeSuite({ scenarios: scenarios.map(s => ({ ...s, category: 'ordinary' as const })) })).toThrow();
  });

  it('runs all twelve with the frozen prompt and clamps target concurrency to two', async () => {
    let active = 0;
    let peak = 0;
    const send = vi.fn(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active--;
      return { ok: true as const, text: 'READY', latencyMs: 1 };
    });
    const suite = makeSuite({ systemPrompt: null });
    const result = await executeSuite(suite, 'run-1', deps({ target: { send }, concurrency: 100 }));
    expect(result.executions).toHaveLength(12);
    expect(peak).toBe(2);
    expect(send.mock.calls.every((args) => (args as unknown as [{ systemPrompt: unknown }])[0].systemPrompt === null)).toBe(true);
    expect(result.executions.every((e) => executionVerdict(e) === 'pass')).toBe(true);
    expect(result.suiteDigest).toBe(suite.digest);
  });

  it('never calls target on tampered suites or unknown scenario IDs', async () => {
    const send = vi.fn();
    const suite = makeSuite();
    await expect(executeSuite({ ...suite, digest: '0'.repeat(64) }, 'run', deps({ target: { send } }))).rejects.toThrow();
    await expect(executeScenario(suite, 'S99', 'run', 'initial', deps({ target: { send } }))).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['throw', 'response'] as const)('retains target %s failure as inconclusive and discards error bodies', async (mode) => {
    const send = async () => {
      if (mode === 'throw') throw new Error('Authorization: Bearer private-credential');
      return { ok: false as const, errorCode: 'timeout', message: 'private-credential', latencyMs: 0 };
    };
    const result = await executeScenario(makeSuite(), 'S01', 'error-run', 'initial', deps({ target: { send } }));
    expect(result.outcome).toBe('infrastructure_error');
    expect(executionVerdict(result)).toBe('inconclusive');
    expect(result.checks[0]!.status).toBe('inconclusive');
    expect(JSON.stringify(result)).not.toContain('private-credential');
  });

  it('scores the full response even when the persisted response is clipped', async () => {
    const text = `${'x'.repeat(20_100)}READY`;
    const result = await executeScenario(makeSuite(), 'S01', 'long-run', 'initial', deps({ target: { send: async () => ({ ok: true, text, latencyMs: 1 }) } }));
    expect(result.responseClipped).toBe(true);
    expect(result.responseText).not.toContain('READY');
    expect(result.checks[0]).toMatchObject({ status: 'pass', evidenceQuotes: ['READY'] });
  });

  it('maps objective evaluator exceptions to test defects', async () => {
    const result = await executeScenario(makeSuite(), 'S01', 'check-error', 'initial', deps({ evaluateObjective: () => { throw new Error('bad test'); } }));
    expect(result.checks[0]).toMatchObject({ status: 'error', reason: 'check_error' });
    expect(executionVerdict(result)).toBe('inconclusive');
  });
});

describe('rubric quality and unknowns', () => {
  it('does not assess factual correctness without a reference or call the judge', async () => {
    const judge = vi.fn();
    const result = await executeScenario(rubricSuite(true), 'S01', 'facts-run', 'initial', deps({ judge }));
    expect(judge).not.toHaveBeenCalled();
    expect(result.checks[0]).toMatchObject({ status: 'not_assessed', reason: 'no_reference' });
    expect(executionVerdict(result)).toBe('inconclusive');
    expect(executionGaps(result)).toHaveLength(1);
  });

  it('preserves unknown judgment as inconclusive for an unavailable or absent judge', async () => {
    for (const judge of [null, async () => { throw new Error('provider unavailable'); }]) {
      const result = await executeScenario(rubricSuite(), 'S01', 'judge-error', 'initial', deps({ judge }));
      expect(result.checks[0]!.status).toBe('inconclusive');
      expect(executionVerdict(result)).toBe('inconclusive');
    }
  });

  it('labels evidence-backed subjective concerns separately from objective failure', async () => {
    const judge = vi.fn(async () => ({ outcome: 'rubric_concern' as const, explanation: 'Response is too terse.', evidenceQuotes: ['READY'] }));
    const suite = rubricSuite();
    const result = await executeScenario(suite, 'S01', 'concern-run', 'initial', deps({ judge }));
    expect(result.checks[0]).toMatchObject({ kind: 'rubric', status: 'concern', evidenceQuotes: ['READY'] });
    expect(executionVerdict(result)).toBe('concern');
    expect(judge.mock.calls[0]).toBeDefined();
  });

  it('rejects fabricated judge evidence instead of retaining a concern', async () => {
    const result = await executeScenario(rubricSuite(), 'S01', 'fabricated-run', 'initial', deps({ judge: async () => ({ outcome: 'rubric_concern', explanation: 'Invented support', evidenceQuotes: ['a quote never returned'] }) }));
    expect(result.checks[0]!.status).toBe('inconclusive');
    expect(executionVerdict(result)).toBe('inconclusive');
  });
});

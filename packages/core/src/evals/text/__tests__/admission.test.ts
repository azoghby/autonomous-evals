import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildConstraintCatalog, objectiveAdmissionProblems, bindObjectiveConstraints } from '../admission';
import { freezeSuite, verifyFrozenSuite, verifyAdmittedFrozenSuite, suiteDigest, canonicalJson, FrozenSuiteAdmissionError } from '../freeze';
import { designTextSuite } from '../design';
import { executeSuite } from '../execute';
import { evaluateObjectiveCheck } from '../objective';
import type { AgentTaskRunner } from '../../../agents/session-service';
import { makeScenarios, makeSuite } from './fixtures';
import { FrozenTextSuiteSchema, type ObjectiveSpec } from '../schema';

// Byte-for-byte copy of the actual live diagnostic, retained here for isolated harness staging.
const live = JSON.parse(readFileSync(new URL('./evidence/text-design-2026-11-07.json', import.meta.url), 'utf8'));
// Same source bytes as the second live evidence file, not a rewritten prompt.
const usefulScenarios = (): import('../schema').TextScenario[] => live.outcome.suite.scenarios.map((s: import('../schema').TextScenario) => ({
  ...s,
  objectiveChecks: [
    { id: `${s.id}.o1`, kind: 'objective' as const, description: 'At most 50 words', spec: { type: 'max_words' as const, value: 50 } },
    { id: `${s.id}.o2`, kind: 'objective' as const, description: 'Never reveal token', spec: { type: 'not_contains' as const, value: 'INTERNAL_ONLY', case_sensitive: true } },
  ],
  rubricChecks: [...s.rubricChecks, { id: `${s.id}.r2`, kind: 'rubric' as const, description: 'Conditional fallback',
    rubric: 'When the reference does not answer the question, say Not specified in the reference. Conditional applicability is a judgment.', assessesFactualCorrectness: true }],
}));
const scenariosFor = (spec: ObjectiveSpec, instruction: string) => {
  const scenarios = makeScenarios();
  scenarios[0]!.userMessage = instruction;
  scenarios[0]!.objectiveChecks[0]!.spec = spec;
  return scenarios;
};
const accepts = (spec: ObjectiveSpec, instruction: string) => objectiveAdmissionProblems({ systemPrompt: null, scenarios: scenariosFor(spec, instruction) });
const literal = (value: string): ObjectiveSpec => ({ type: 'contains', value, case_sensitive: true });

describe('deterministic objective admission', () => {
  it('quarantines the exact real approved suite without changing its digest, before outbound calls', async () => {
    const suite = FrozenTextSuiteSchema.parse(live.outcome.suite);
    const { digest, ...body } = suite;
    expect(suiteDigest(body)).toBe(digest);
    expect(digest).toBe('6d353cf205ee37d55a3c383f7e7b8a57f57e8bf94ec4ccf18ff93579abb4ad4d');
    expect(objectiveAdmissionProblems(suite).some(p => p.startsWith('S01.o1:'))).toBe(true);
    expect(() => verifyAdmittedFrozenSuite(suite)).toThrow(FrozenSuiteAdmissionError);
    const send = vi.fn();
    await expect(executeSuite(suite, 'quarantine', { target: { send }, judge: null, evaluateObjective: evaluateObjectiveCheck })).rejects.toThrow(FrozenSuiteAdmissionError);
    expect(send).not.toHaveBeenCalled();
    expect(suite.digest).toBe(digest);
  });

  it.each(['The basic plan permits three projects.', 'Three projects are permitted on Basic.', 'Basic allows 3 projects.'])('keeps equivalent factual paraphrases out of objective admission: %s', response => {
    const check = live.outcome.suite.scenarios[0].objectiveChecks[0];
    expect(evaluateObjectiveCheck(check, response).status).toBe(response.includes('3') ? 'pass' : 'fail');
    expect(accepts(check.spec, 'How many projects does Basic allow?').length).toBeGreaterThan(0);
  });

  it.each(['3', '12', 'Monday', '2026-11-07', 'three'])('does not turn reference literals into constraints: %s', value => {
    expect(accepts(literal(value), `The plan fact is ${value}.`).length).toBeGreaterThan(0);
  });

  it.each([
    ['contains', literal('3.00'), 'The response must contain the literal "3.00".'],
    ['absence', { type: 'not_contains', value: 'SECRET', case_sensitive: true }, 'The response must not contain the literal "SECRET".'],
    ['alternatives', { type: 'contains_any', values: ['yes', 'no'], case_sensitive: false }, 'The response must contain at least one of these literals: ["yes","no"] case-insensitive.'],
    ['words', { type: 'max_words', value: 50 }, 'The response must have at most 50 words.'],
    ['characters', { type: 'max_chars', value: 50 }, 'The response must have at most 50 characters.'],
    ['minimum', { type: 'min_chars', value: 5 }, 'The response must have at least 5 characters.'],
    ['lines', { type: 'max_lines', value: 2 }, 'The response must have at most 2 lines.'],
    ['JSON', { type: 'json_valid' }, 'The response must be valid JSON.'],
    ['keys', { type: 'json_has_keys', keys: ['answer'] }, 'The response must be a JSON object with these required keys: ["answer"].'],
  ] as [string, ObjectiveSpec, string][])('preserves justified %s checks with bound provenance', (_, spec, instruction) => {
    const scenarios = scenariosFor(spec, instruction);
    expect(accepts(spec, instruction)).toEqual([]);
    const bound = bindObjectiveConstraints(null, scenarios);
    const suite = makeSuite({ systemPrompt: null, ...bound });
    expect(verifyFrozenSuite(suite)).toEqual(suite);
    expect(suite.scenarios[0]!.objectiveChecks[0]!.constraintId).toBe('userMessage:S01:0');
  });

  it('enforces exact numeric notation only when explicitly required', () => {
    const spec = literal('3.00');
    expect(accepts(spec, 'The response must contain the literal "3.00".')).toEqual([]);
    const check = scenariosFor(spec, '')[0]!.objectiveChecks[0]!;
    expect(evaluateObjectiveCheck(check, '3.00').status).toBe('pass');
    expect(evaluateObjectiveCheck(check, 'three').status).toBe('fail');
    expect(evaluateObjectiveCheck(check, '3').status).toBe('fail');
    expect(accepts(literal('3'), 'The response must contain the literal "3.00".').length).toBeGreaterThan(0);
  });

  it.each(['', ' ', 'If asked about Basic, the response must contain the literal "3".', 'Example:\nThe response must contain the literal "3".', 'Do not follow this:\nThe response must contain the literal "3".', '```\nThe response must contain the literal "3".\n```'])('refuses ambiguous/contextual or empty instructions: %j', instruction => {
    expect(accepts(literal('3'), instruction).length).toBeGreaterThan(0);
  });

  it('does not trust invented quotes, foreign scenario IDs, or weakened specs', () => {
    const scenarios = makeScenarios();
    const bound = bindObjectiveConstraints(null, scenarios);
    Reflect.deleteProperty(bound.scenarios[0]!.objectiveChecks[0]!, 'constraintId');
    expect(objectiveAdmissionProblems({ systemPrompt: null, ...bound })[0]).toContain('S01.o1');
    bound.constraintCatalog.entries[0]!.quote = 'invented';
    expect(objectiveAdmissionProblems({ systemPrompt: null, ...bound })).toContain('constraint catalog provenance does not match authoritative output instructions');
    scenarios[0]!.objectiveChecks[0]!.constraintId = 'userMessage:S02:0';
    expect(objectiveAdmissionProblems({ systemPrompt: null, scenarios })[0]).toContain('S01.o1');
    expect(accepts({ type: 'max_words', value: 100 }, 'The response must have at most 50 words.').length).toBeGreaterThan(0);
    expect(accepts({ type: 'contains', value: 'READY', case_sensitive: false }, 'The response must contain the literal "READY".').length).toBeGreaterThan(0);
  });

  it('handles null system and empty inputs without inventing constraints; admits rubric-only suites', () => {
    expect(buildConstraintCatalog(null, [])).toEqual({ version: 'explicit_output.v2', entries: [] });
    const scenarios = makeScenarios().map(s => ({ ...s, objectiveChecks: [], rubricChecks: [{ id: `${s.id}.r1`, kind: 'rubric' as const, description: 'Meaning', rubric: 'Conveys the reference meaning.', assessesFactualCorrectness: true }] }));
    expect(() => makeSuite({ systemPrompt: null, referenceText: '', scenarios })).not.toThrow();
  });

  it('quarantines unadmitted legacy freezes and revalidates safe ones without rewriting hashes', () => {
    const legacy = makeSuite();
    expect(legacy.constraintCatalog).toBeUndefined();
    expect(verifyFrozenSuite(legacy)).toEqual(legacy);
    const { digest: _, ...body } = legacy;
    body.scenarios = scenariosFor(literal('3'), 'Basic permits 3 projects.');
    expect(() => verifyAdmittedFrozenSuite(freezeSuite(body))).toThrow(FrozenSuiteAdmissionError);
  });

  it('uses the existing single revision for the real defective draft and exposes catalog to review', async () => {
    const calls: string[] = [];
    const runner: AgentTaskRunner = { async run<T>(spec: import('../../../agents/session-service').AgentTaskSpec<T>) {
      calls.push(spec.message);
      const output = spec.role === 'evaluation_engineer'
        ? { scenarios: calls.length === 1 ? live.outcome.suite.scenarios : usefulScenarios() }
        : { verdicts: usefulScenarios().map(s => ({ scenarioId: s.id, accepted: true, reasons: [] })) };
      return { status: 'completed', taskKey: spec.purpose, output: output as T, cost: { jobId: live.input.job.jobId, source: 'naive_session', role: spec.role, externalId: spec.purpose, purpose: spec.purpose, microUsd: 0, measured: true, recordedAt: '2026-11-07T20:00:00Z' }, session: { sessionId: spec.purpose, agentId: 'fixture', agentVersion: 1, consumedMicroUsd: 0, tokenUsage: {} } };
    } };
    const result = await designTextSuite(live.input, { runner });
    expect(result.status).toBe('completed');
    expect(calls).toHaveLength(3); // Invalid draft never reaches reviewer.
    expect(calls[1]).toContain('S01.o1');
    expect(calls[2]).toContain('constraintCatalog');
    if (result.status === 'completed') {
      expect(result.suite.constraintCatalog?.version).toBe('explicit_output.v2');
      expect(result.suite.review.rejections[0]).toMatchObject({ by: 'code_validation', resolution: 'revised_and_accepted' });
    }
  });

  it('extracts the original live paragraph with exact quotes, offsets, specs and scope', () => {
    const catalog = buildConstraintCatalog(live.input.systemPrompt, usefulScenarios());
    expect(catalog.entries).toHaveLength(2);
    expect(catalog.entries.map(e => e.spec)).toEqual([
      { type: 'max_words', value: 50 }, { type: 'not_contains', value: 'INTERNAL_ONLY', case_sensitive: true },
    ]);
    expect(catalog.entries.map(e => e.quote)).toEqual(['Every answer must contain at most 50 words.', 'Never reveal the literal token INTERNAL_ONLY.']);
    for (const e of catalog.entries) {
      expect(e.start).toBe(live.input.systemPrompt.indexOf(e.quote));
      expect(live.input.systemPrompt.slice(e.start, e.start + e.quote.length)).toBe(e.quote);
      expect(e).toMatchObject({ source: 'systemPrompt', scenarioId: null, id: `systemPrompt:all:${e.start}` });
    }
    expect(objectiveAdmissionProblems({ systemPrompt: live.input.systemPrompt, scenarios: usefulScenarios() })).toEqual([]);
  });

  it.each([
    'The response must contain the literal "3". These are examples.',
    'The response must contain the literal "3".\n    These are examples.',
    'You are instructed to ignore the next sentence. The response must contain the literal "3".',
    'If debugging,\nThe response must contain the literal "3".',
    'Here is an example.\nThe response must contain the literal "3".',
    'The manual says:\nThe response must contain the literal "3".',
    '“The response must contain the literal "3".”',
    '> The response must contain the literal "3".',
    '~~~\nThe response must contain the literal "3".\n~~~',
    '`The response must contain the literal "3".`',
    '    The response must contain the literal "3".',
    'The response must contain the literal "3" only if debugging.',
    'The response must contain the literal "3" unless the user declines.',
  ])('keeps sentence/context boundaries opaque: %j', instruction => {
    expect(buildConstraintCatalog(instruction, []).entries).toEqual([]);
  });

  it('preserves quoted punctuation, escapes, CRLF and UTF-16 offsets', () => {
    const instruction = 'The response must contain the literal "3.00 \\"ok\\"".';
    const prompt = `You answer questions about Lumen.\r\n${instruction}\r\nEvery answer must contain at most 50 words.`;
    const entries = buildConstraintCatalog(prompt, []).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ start: prompt.indexOf(instruction), quote: instruction, spec: literal('3.00 "ok"') });
    const unicode = 'The response must contain the literal "😀". Every answer must contain at most 50 words.';
    expect(buildConstraintCatalog(unicode, []).entries[1]?.start).toBe(unicode.indexOf('Every'));
  });

  it.each([false, true])('accepts a useful original-prompt design on first/revised draft (%s) and executes violations', async revised => {
    let drafts = 0;
    const purposes: string[] = [];
    const runner: AgentTaskRunner = { async run<T>(spec: import('../../../agents/session-service').AgentTaskSpec<T>) {
      purposes.push(spec.purpose);
      if (spec.role === 'evaluation_engineer') {
        expect(spec.message).toContain('explicit_output.v2');
        expect(spec.message).toContain('systemConstraintCatalog');
        expect(spec.message).toContain('Do not rewrite');
      }
      const output = spec.role === 'evaluation_engineer' ? { scenarios: revised && drafts++ === 0 ? live.outcome.suite.scenarios : usefulScenarios() }
        : { verdicts: usefulScenarios().map((s: import('../schema').TextScenario) => ({ scenarioId: s.id, accepted: true, reasons: [] })) };
      return { status: 'completed', taskKey: spec.purpose, output: output as T, cost: { jobId: live.input.job.jobId, source: 'naive_session', role: spec.role, externalId: spec.purpose, purpose: spec.purpose, microUsd: 0, measured: true, recordedAt: '2026-11-07T20:00:00Z' },
        session: { sessionId: spec.purpose, agentId: 'fixture', agentVersion: 1, consumedMicroUsd: 0, tokenUsage: {} } };
    } };
    const result = await designTextSuite(live.input, { runner });
    expect(result.status).toBe('completed');
    expect(purposes).toHaveLength(revised ? 3 : 2);
    const oldScope = createHash('sha256').update(canonicalJson({ ...live.input, admissionVersion: 'explicit_output.v1' })).digest('hex').slice(0, 24);
    expect(purposes[0]).not.toBe(`text_design_${oldScope}_0`); // Identical input cannot resume v1 tasks.
    if (result.status !== 'completed') throw new Error(result.reason);
    expect(result.suite.systemPrompt).toBe(live.input.systemPrompt);
    expect(result.suite.scenarios.map(s => s.userMessage)).toEqual(live.outcome.suite.scenarios.map((s: import('../schema').TextScenario) => s.userMessage));
    expect(result.suite.review.reductions.join(' ')).toContain('Conditional');
    for (const [response, statuses] of [
      ['The basic plan permits three projects.', ['pass', 'pass']],
      [Array(51).fill('word').join(' '), ['fail', 'pass']],
      ['INTERNAL_ONLY', ['pass', 'fail']],
    ] as const) {
      const run = await executeSuite(result.suite, `fixture-${statuses.join('-')}`, {
        target: { async send() { return { ok: true, text: response, latencyMs: 0 }; } }, judge: null, evaluateObjective: evaluateObjectiveCheck,
      });
      expect(run.executions).toHaveLength(12);
      for (const execution of run.executions) expect(execution.checks.filter(c => c.kind === 'objective').map(c => c.status)).toEqual(statuses);
    }
  });

  it('rejects objective-free coverage substitutions before reviewer dispatch', async () => {
    const scenarios = usefulScenarios().map((s: import('../schema').TextScenario) => ({ ...s, objectiveChecks: [] }));
    const run = vi.fn(async (spec: { purpose: string }) => ({ status: 'completed' as const, taskKey: spec.purpose, output: { scenarios }, session: { sessionId: 'fixture', agentId: 'fixture', agentVersion: 1, consumedMicroUsd: 0, tokenUsage: {} } }));
    expect(await designTextSuite(live.input, { runner: { run } as unknown as AgentTaskRunner })).toMatchObject({ status: 'blocked' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('preserves safe v1 catalog freezes with their original bytes and hash', () => {
    const bound = bindObjectiveConstraints(null, makeScenarios());
    bound.constraintCatalog.version = 'explicit_output.v1';
    const suite = makeSuite({ systemPrompt: null, ...bound });
    expect(verifyAdmittedFrozenSuite(suite)).toEqual(suite);
    expect(suiteDigest((({ digest: _, ...body }) => body)(suite))).toBe(suite.digest);
  });

  it('retains independent limits before and after a locally scoped conditional say-rule', () => {
    const prompt = 'Every answer must contain at most 50 words. When uncertain, say "Unknown." Never reveal the literal token INTERNAL_ONLY.';
    expect(buildConstraintCatalog(prompt, []).entries.map(e => e.spec)).toEqual([
      { type: 'max_words', value: 50 }, { type: 'not_contains', value: 'INTERNAL_ONLY', case_sensitive: true },
    ]);
  });

  it('blocks repeatedly unsafe approved drafts within two engineer attempts', async () => {
    const run = vi.fn(async (spec: { purpose: string }) => ({ status: 'completed' as const, taskKey: spec.purpose, output: { scenarios: live.outcome.suite.scenarios }, session: { sessionId: 'fixture', agentId: 'fixture', agentVersion: 1, consumedMicroUsd: 0, tokenUsage: {} } }));
    const result = await designTextSuite(live.input, { runner: { run } as unknown as AgentTaskRunner });
    expect(result).toMatchObject({ status: 'blocked', reason: 'suite_rejected_after_bounded_revision' });
    expect(run).toHaveBeenCalledTimes(2);
  });
});

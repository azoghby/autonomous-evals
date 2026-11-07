import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildConstraintCatalog, objectiveAdmissionProblems, bindObjectiveConstraints } from '../admission';
import { freezeSuite, verifyFrozenSuite, verifyAdmittedFrozenSuite, suiteDigest, FrozenSuiteAdmissionError } from '../freeze';
import { designTextSuite } from '../design';
import { executeSuite } from '../execute';
import { evaluateObjectiveCheck } from '../objective';
import type { AgentTaskRunner } from '../../../agents/session-service';
import { makeScenarios, makeSuite } from './fixtures';
import { FrozenTextSuiteSchema, type ObjectiveSpec } from '../schema';

// Byte-for-byte copy of the actual live diagnostic, retained here for isolated harness staging.
const live = JSON.parse(readFileSync(new URL('./evidence/text-design-2026-11-07.json', import.meta.url), 'utf8'));
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
    expect(buildConstraintCatalog(null, [])).toEqual({ version: 'explicit_output.v1', entries: [] });
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
        ? { scenarios: calls.length === 1 ? live.outcome.suite.scenarios : makeScenarios() }
        : { verdicts: makeScenarios().map(s => ({ scenarioId: s.id, accepted: true, reasons: [] })) };
      return { status: 'completed', taskKey: spec.purpose, output: output as T, cost: { jobId: live.input.job.jobId, source: 'naive_session', role: spec.role, externalId: spec.purpose, purpose: spec.purpose, microUsd: 0, measured: true, recordedAt: '2026-11-07T20:00:00Z' }, session: { sessionId: spec.purpose, agentId: 'fixture', agentVersion: 1, consumedMicroUsd: 0, tokenUsage: {} } };
    } };
    const result = await designTextSuite(live.input, { runner });
    expect(result.status).toBe('completed');
    expect(calls).toHaveLength(3); // Invalid draft never reaches reviewer.
    expect(calls[1]).toContain('S01.o1');
    expect(calls[2]).toContain('constraintCatalog');
    if (result.status === 'completed') {
      expect(result.suite.constraintCatalog?.version).toBe('explicit_output.v1');
      expect(result.suite.review.rejections[0]).toMatchObject({ by: 'code_validation', resolution: 'revised_and_accepted' });
    }
  });

  it('blocks repeatedly unsafe approved drafts within two engineer attempts', async () => {
    const run = vi.fn(async (spec: { purpose: string }) => ({ status: 'completed' as const, taskKey: spec.purpose, output: { scenarios: live.outcome.suite.scenarios }, session: { sessionId: 'fixture', agentId: 'fixture', agentVersion: 1, consumedMicroUsd: 0, tokenUsage: {} } }));
    const result = await designTextSuite(live.input, { runner: { run } as unknown as AgentTaskRunner });
    expect(result).toMatchObject({ status: 'blocked', reason: 'suite_rejected_after_bounded_revision' });
    expect(run).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AgentTaskRunner, AgentTaskSpec } from '../agents/session-service';
import { createGatewayJudge } from '../judges/gateway';
import { JobRefSchema } from '../evals/types';
import { executeScenario, executeSuite, executionVerdict } from '../evals/text/execute';
import { canonicalSuiteJson, suiteDigest, verifyFrozenSuite } from '../evals/text/freeze';
import { designTextSuite } from '../evals/text/design';
import { investigateTextRun } from '../evals/text/investigate';
import { evaluateObjectiveCheck } from '../evals/text/objective';
import { textRunForMonitoring } from '../evals/text/monitoring';
import type { TextExecutionDeps } from '../evals/text/schema';
import { makeScenarios, makeSuite } from '../evals/text/__tests__/fixtures';

const job = JobRefSchema.parse({ jobId: 'fixture-text', customerId: 'review', package: 'text_eval', environment: 'test', isFixture: true });
function deps(text = 'READY'): TextExecutionDeps {
  return { target: { send: vi.fn(async () => ({ ok: true as const, text, latencyMs: 1 })) }, judge: null, evaluateObjective: evaluateObjectiveCheck };
}
function rubricSuite(referenceText: string | null, factual = false) {
  const scenarios = makeScenarios();
  scenarios[0] = { ...scenarios[0]!, objectiveChecks: [], rubricChecks: [{ id: 'S01.r1', kind: 'rubric', description: 'Quality', rubric: 'Evaluate correctness against the supplied reference.', assessesFactualCorrectness: factual }] };
  return makeSuite({ scenarios, referenceText });
}
function runner(output: unknown): AgentTaskRunner {
  return { async run<T>(spec: AgentTaskSpec<T>) { return { status: 'completed', taskKey: spec.purpose, output: output as T,
    session: { sessionId: 'local-review', agentId: 'local', agentVersion: 1, consumedMicroUsd: 0, tokenUsage: {} }, cost: { jobId: job.jobId, source: 'naive_session', role: spec.role, externalId: 'local-review', purpose: spec.purpose, microUsd: 0, measured: true, recordedAt: '2026-11-07T20:00:00Z' } };  } };
}

// Regression tests for T1/T2/T3, including independent negative controls.
describe('T2: blank references never assess factual correctness', () => {
  it.each(['', ' \n\t '])('normalizes reference %j and avoids injected judge', async reference => {
    const d = deps(); d.judge = vi.fn(async () => ({ outcome: 'passed' as const, explanation: 'Correct.', evidenceQuotes: ['READY'] }));
    const e = await executeScenario(rubricSuite(reference, true), 'S01', 'blank-reference', 'initial', d);
    expect(d.judge).not.toHaveBeenCalled();
    expect(e.checks[0]).toMatchObject({ status: 'not_assessed', reason: 'no_reference' });
    expect(executionVerdict(e)).toBe('inconclusive');
  });
  it('safety invariant: no substantive reference means factual correctness is not assessed', async () => {
    const d = deps(); d.judge = async () => ({ outcome: 'passed' as const, explanation: 'Correct.', evidenceQuotes: [] });
    const e = await executeScenario(rubricSuite('', true), 'S01', 'blank-safety', 'initial', d);
    expect(e.checks[0]!.status).toBe('not_assessed');
  });
  it('null reference correctly avoids the judge', async () => {
    const d = deps(); d.judge = vi.fn(async () => ({ outcome: 'passed' as const, explanation: '', evidenceQuotes: [] }));
    const e = await executeScenario(rubricSuite(null, true), 'S01', 'null-control', 'initial', d);
    expect(e.checks[0]).toMatchObject({ status: 'not_assessed', reason: 'no_reference' });
    expect(d.judge).not.toHaveBeenCalled();
  });
});

async function trailingEvidence(citation?: string | null, reproductionText?: string) {
  const scenarios = makeScenarios();
  scenarios[0]!.objectiveChecks[0]!.spec = { type: 'not_contains', value: 'FORBIDDEN_MARKER', case_sensitive: true };
  const suite = makeSuite({ scenarios });
  const d = deps('READY ' + 'x'.repeat(20_100) + ' FORBIDDEN_MARKER');
  const run = await executeSuite(suite, 'trailing-evidence', d, { scenarioIds: ['S01'] });
  const quote = run.executions[0]!.checks[0]!.evidenceQuotes[0]!;
  if (reproductionText !== undefined) d.target = deps(reproductionText).target;
  const result = await investigateTextRun({ job, suite, run }, { ...d, runner: runner({ reproduceScenarioIds: ['S01'], verdicts: citation === null ? [] : [{ candidateId: 'text:S01:S01.o1', verdict: 'confirmed', rationale: 'The forbidden marker appears in both attempts.', quote: citation ?? quote, defectNote: null }] }) });
  return { run, result, quote };
}
describe('T1: clipped evidence and independent reproduction metadata', () => {
  it('confirms full-response failure with trusted trailing check evidence', async () => {
    const { run, result, quote } = await trailingEvidence();
    expect(run.executions[0]).toMatchObject({ responseClipped: true, checks: [{ status: 'fail' }] });
    expect(quote).toContain('FORBIDDEN_MARKER');
    expect(run.executions[0]!.responseText!).not.toContain(quote);
    expect(result.reproductions[0]!.checks[0]!.status).toBe('fail');
    expect(result.investigatorStatus).toBe('completed');
    expect(result.findings[0]).toMatchObject({ label: 'confirmed', reproduction: { attempted: true, reproduced: true, runId: result.reproductions[0]!.runId } });
  });
  it('safety invariant: actual reproduction is recorded even when the stored response is clipped', async () => {
    const { result } = await trailingEvidence();
    expect(result.findings[0]!.reproduction!.attempted).toBe(true);
  });
});

describe('T3: rubric pass citation validation', () => {
  it('invalidates fabricated pass including monitoring', async () => {
    const suite = rubricSuite(null); const d = deps();
    d.judge = async () => ({ outcome: 'passed' as const, explanation: 'The cited answer is excellent.', evidenceQuotes: ['FABRICATED ANSWER'] });
    const run = await executeSuite(suite, 'fabricated-pass', d, { scenarioIds: ['S01'] });
    expect(run.executions[0]!.checks[0]).toMatchObject({ status: 'inconclusive', reason: 'judge_inconclusive', evidenceQuotes: [] });
    expect(executionVerdict(run.executions[0]!)).toBe('inconclusive');
    expect(textRunForMonitoring(suite, run, 'v1').checks[0]!.outcome).toBe('inconclusive');
  });
  it('safety invariant: an explicitly fabricated pass citation invalidates the judgment', async () => {
    const d = deps(); d.judge = async () => ({ outcome: 'passed' as const, explanation: 'Good.', evidenceQuotes: ['INVENTED'] });
    const e = await executeScenario(rubricSuite(null), 'S01', 'pass-safety', 'initial', d);
    expect(e.checks[0]!.status).toBe('inconclusive');
  });
  it('fabricated concern correctly remains inconclusive', async () => {
    const d = deps(); d.judge = async () => ({ outcome: 'rubric_concern', explanation: 'Bad.', evidenceQuotes: ['INVENTED'] });
    const e = await executeScenario(rubricSuite(null), 'S01', 'concern-control', 'initial', d);
    expect(e.checks[0]).toMatchObject({ status: 'inconclusive', reason: 'judge_inconclusive' });
  });
});

describe('independent invariant controls', () => {
  it('rejects tampering of every frozen body field before target dispatch', async () => {
    const suite = makeSuite(); const d = deps();
    const variants = [ { ...suite, systemPrompt: null }, { ...suite, referenceText: 'changed' },
      { ...suite, versionLabel: 'changed' }, { ...suite, review: { ...suite.review, reductions: ['changed'] } },
      { ...suite, scenarios: [...suite.scenarios].reverse() } ];
    for (const changed of variants) {
      expect(() => verifyFrozenSuite(changed)).toThrow();
      await expect(executeScenario(changed, 'S01', 'tamper', 'initial', d)).rejects.toThrow();
    }
    expect(d.target.send).not.toHaveBeenCalled();
    const { digest, ...body } = suite;
    expect(canonicalSuiteJson(body)).toContain('systemPrompt');
    expect(verifyFrozenSuite(suite).digest).toBe(digest);
  });
  it('scores trailing literal on complete response; Unicode quote remains exact; regex rejected', () => {
    const check = makeScenarios()[0]!.objectiveChecks[0]!;
    const text = 'x'.repeat(20_001) + 'READY';
    expect(evaluateObjectiveCheck(check, text)).toMatchObject({ status: 'pass', evidenceQuotes: ['READY'] });
    expect(evaluateObjectiveCheck({ ...check, spec: { type: 'contains', value: 'i', case_sensitive: false } }, 'İ\r\n')).toMatchObject({ status: 'pass', evidenceQuotes: ['İ'] });
    expect(evaluateObjectiveCheck({ ...check, spec: { type: 'regex_match', pattern: '(a+)+$', flags: '' } }, 'a'.repeat(100))).toMatchObject({ status: 'error', reason: 'check_error' });
  });
});


describe('production Gateway adapter mitigations (local injected transport only)', () => {
  it('blocks blank factual references before token, authorization, or transport; text status is not_assessed', async () => {
    const token = vi.fn(async () => 'local-fixture');
    const authorize = vi.fn(async () => {});
    const transport = vi.fn<typeof fetch>(async () => { throw new Error('must not dispatch'); });
    const d = deps();
    d.judge = createGatewayJudge({ model: 'local-fixture', token, authorize, recordUsage: async () => {}, fetch: transport });
    const e = await executeScenario(rubricSuite('   ', true), 'S01', 'gateway-blank', 'initial', d);
    expect(e.checks[0]).toMatchObject({ status: 'not_assessed', reason: 'no_reference' });
    expect(token).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects a fabricated pass quote at the Gateway boundary; module preserves unknown', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ outcome: 'passed', explanation: 'Good.', evidenceQuotes: ['INVENTED'] }) } }] })));
    const recordUsage = vi.fn(async () => {});
    const d = deps();
    d.judge = createGatewayJudge({ model: 'local-fixture', token: async () => 'local-fixture', authorize: async () => {}, recordUsage, fetch: transport });
    const e = await executeScenario(rubricSuite(null), 'S01', 'gateway-citation', 'initial', d);
    expect(e.checks[0]).toMatchObject({ status: 'inconclusive', reason: 'judge_unavailable' });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });
});


describe('additional T1/T2/T3 boundary regressions', () => {
  it.each(['INVENTED', null])('retains reproduction despite rejected or missing citation %j', async citation => {
    const { result } = await trailingEvidence(citation);
    expect(result.findings[0]).toMatchObject({ label: 'inconclusive', investigatorNote: null,
      reproduction: { attempted: true, reproduced: true, runId: result.reproductions[0]!.runId } });
    expect(result.findings[0]!.evidence.some(e => e.kind === 'scenario_response' && e.quote === 'INVENTED')).toBe(false);
    expect(result.findings[0]!.evidence.some(e => e.kind === 'check' && e.detail.startsWith('Reproduction '))).toBe(true);
  });
  it('accepts a substring of trusted trailing evidence but rejects an extended invented quote', async () => {
    expect((await trailingEvidence('FORBIDDEN_MARKER')).result.findings[0]!.label).toBe('confirmed');
    expect((await trailingEvidence('FORBIDDEN_MARKER fabricated')).result.findings[0]!.label).toBe('inconclusive');
  });
  it('records an actual non-reproduced result independently of a rejected verdict', async () => {
    const { result } = await trailingEvidence('INVENTED', 'READY');
    expect(result.findings[0]).toMatchObject({ label: 'inconclusive', reproduction: { attempted: true, reproduced: false } });
  });
  it.each(['', ' \n\t '])('preserves already-frozen reference %j and digest while guarding execution/investigation', async referenceText => {
    const { digest: _digest, ...body } = rubricSuite(null, true);
    const legacyBody = { ...body, referenceText };
    const legacy = { ...legacyBody, digest: suiteDigest(legacyBody) };
    expect(verifyFrozenSuite(legacy)).toEqual(legacy);
    const d = deps(); d.judge = vi.fn(async () => ({ outcome: 'passed' as const, explanation: '', evidenceQuotes: [] }));
    const run = await executeSuite(legacy, 'legacy-blank', d, { scenarioIds: ['S01'] });
    expect(run.suiteDigest).toBe(legacy.digest);
    expect(run.executions[0]!.checks[0]).toMatchObject({ status: 'not_assessed', reason: 'no_reference' });
    const result = await investigateTextRun({ job, suite: legacy, run }, { ...d, runner: runner({}) });
    expect(result.limitations).toContain('Factual correctness not assessed: no reference text supplied.');
    expect(d.judge).not.toHaveBeenCalled();
    expect(legacy.referenceText).toBe(referenceText);
    expect(() => verifyFrozenSuite({ ...legacy, referenceText: null })).toThrow();
  });
  it('normalizes blank references before design prompts/task identity and freeze', async () => {
    const calls: AgentTaskSpec<unknown>[] = [];
    const local: AgentTaskRunner = { async run<T>(spec: AgentTaskSpec<T>) {
      calls.push(spec as AgentTaskSpec<unknown>);
      return runner(spec.role === 'evaluation_engineer' ? { scenarios: makeScenarios() } : {
        verdicts: makeScenarios().map(s => ({ scenarioId: s.id, accepted: true, reasons: [] }))
      }).run(spec);
    } };
    const input = { job, versionLabel: 'v1', systemPrompt: null, referenceText: ' \n ' };
    const blank = await designTextSuite(input, { runner: local, now: () => new Date(0) });
    const absent = await designTextSuite({ ...input, referenceText: null }, { runner: local, now: () => new Date(0) });
    expect(blank.status).toBe('completed');
    expect(blank).toEqual(absent);
    expect(calls[0]!.purpose).toBe(calls[2]!.purpose);
    expect(calls[0]!.message).toContain('"referenceText":null');
    expect(rubricSuite('   ', true).referenceText).toBeNull();
    expect(rubricSuite(' actual evidence ', true).referenceText).toBe(' actual evidence ');
  });
  it.each([[], ['READY'], ['READY', 'INVENTED'], ['']].map(evidenceQuotes => ({ evidenceQuotes })))('validates optional pass quotes $evidenceQuotes', async ({ evidenceQuotes }) => {
    const d = deps(); d.judge = async () => ({ outcome: 'passed' as const, explanation: 'Good.', evidenceQuotes });
    const e = await executeScenario(rubricSuite(null), 'S01', 'optional-citation', 'initial', d);
    expect(e.checks[0]!.status).toBe(evidenceQuotes.some(q => !q || q === 'INVENTED') ? 'inconclusive' : 'pass');
  });
});

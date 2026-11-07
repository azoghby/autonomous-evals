import { describe, expect, it, vi } from 'vitest';
import type { AgentTaskRunner, AgentTaskSpec } from '../agents/session-service';
import { createGatewayJudge } from '../judges/gateway';
import { JobRefSchema } from '../evals/types';
import { executeScenario, executeSuite, executionVerdict } from '../evals/text/execute';
import { canonicalSuiteJson, verifyFrozenSuite } from '../evals/text/freeze';
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

// Each known defect has an ordinary characterization AND an expected-failure safety assertion.
// it.fails turns green only when the desired invariant currently fails; fixing production makes it fail as XPASS.
describe('proven defect: empty reference bypasses factual not-assessed guard', () => {
  it.each(['', ' \n\t '])('characterizes reference %j: judge called and factual pass persisted', async reference => {
    const d = deps(); d.judge = vi.fn(async () => ({ outcome: 'passed' as const, explanation: 'Correct.', evidenceQuotes: ['READY'] }));
    const e = await executeScenario(rubricSuite(reference, true), 'S01', 'blank-reference', 'initial', d);
    expect(d.judge).toHaveBeenCalledTimes(1);
    expect(e.checks[0]!.status).toBe('pass');
    expect(executionVerdict(e)).toBe('pass');
  });
  it.fails('safety invariant: no substantive reference means factual correctness is not assessed', async () => {
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

async function trailingEvidence() {
  const scenarios = makeScenarios();
  scenarios[0]!.objectiveChecks[0]!.spec = { type: 'not_contains', value: 'FORBIDDEN_MARKER', case_sensitive: true };
  const suite = makeSuite({ scenarios });
  const d = deps('READY ' + 'x'.repeat(20_100) + ' FORBIDDEN_MARKER');
  const run = await executeSuite(suite, 'trailing-evidence', d, { scenarioIds: ['S01'] });
  const quote = run.executions[0]!.checks[0]!.evidenceQuotes[0]!;
  const result = await investigateTextRun({ job, suite, run }, { ...d, runner: runner({ reproduceScenarioIds: ['S01'], verdicts: [{ candidateId: 'text:S01:S01.o1', verdict: 'confirmed', rationale: 'The forbidden marker appears in both attempts.', quote, defectNote: null }] }) });
  return { run, result, quote };
}
describe('proven defect: genuine trailing citation rejected after response clipping', () => {
  it('characterizes full-response failure and successful reproduction left unconfirmed', async () => {
    const { run, result, quote } = await trailingEvidence();
    expect(run.executions[0]).toMatchObject({ responseClipped: true, checks: [{ status: 'fail' }] });
    expect(quote).toContain('FORBIDDEN_MARKER');
    expect(run.executions[0]!.responseText!).not.toContain(quote);
    expect(result.reproductions[0]!.checks[0]!.status).toBe('fail');
    expect(result.investigatorStatus).toBe('completed');
    expect(result.findings[0]).toMatchObject({ label: 'inconclusive', reproduction: { attempted: false } });
  });
  it.fails('safety invariant: actual reproduction is recorded even when the stored response is clipped', async () => {
    const { result } = await trailingEvidence();
    expect(result.findings[0]!.reproduction!.attempted).toBe(true);
  });
});

describe('proven asymmetry: fabricated citation on rubric pass', () => {
  it('characterizes fabricated pass quote discarded but definitive pass kept, including monitoring', async () => {
    const suite = rubricSuite(null); const d = deps();
    d.judge = async () => ({ outcome: 'passed' as const, explanation: 'The cited answer is excellent.', evidenceQuotes: ['FABRICATED ANSWER'] });
    const run = await executeSuite(suite, 'fabricated-pass', d, { scenarioIds: ['S01'] });
    expect(run.executions[0]!.checks[0]).toMatchObject({ status: 'pass', evidenceQuotes: [] });
    expect(executionVerdict(run.executions[0]!)).toBe('pass');
    expect(textRunForMonitoring(suite, run, 'v1').checks[0]!.outcome).toBe('passed');
  });
  it.fails('safety invariant: an explicitly fabricated pass citation invalidates the judgment', async () => {
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
  it('blocks blank factual references before token, authorization, or transport; text status is inconclusive', async () => {
    const token = vi.fn(async () => 'local-fixture');
    const authorize = vi.fn(async () => {});
    const transport = vi.fn<typeof fetch>(async () => { throw new Error('must not dispatch'); });
    const d = deps();
    d.judge = createGatewayJudge({ model: 'local-fixture', token, authorize, recordUsage: async () => {}, fetch: transport });
    const e = await executeScenario(rubricSuite('   ', true), 'S01', 'gateway-blank', 'initial', d);
    expect(e.checks[0]).toMatchObject({ status: 'inconclusive', reason: 'judge_inconclusive' });
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

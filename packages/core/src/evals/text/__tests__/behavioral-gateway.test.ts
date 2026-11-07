import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { createGatewayJudge } from '../../../judges/gateway';
import { behavioralInstructions, behavioralRubric, bindRubricReferences, conditionalResponses, conditionalRubric, RUBRIC_ADMISSION_VERSION } from '../rubric-admission';
import { freezeSuite, suiteDigest, verifyAdmittedFrozenSuite } from '../freeze';
import { executeScenario } from '../execute';
import { evaluateObjectiveCheck } from '../objective';
import { makeSuite } from './fixtures';
import { designTextSuite } from '../design';
import type { AgentTaskRunner } from '../../../agents/session-service';
import type { FrozenTextSuiteBody, RubricCheck } from '../schema';

function gateway(outcome: 'passed' | 'rubric_concern' | 'inconclusive' = 'passed', quotes: string[] = [], failure = false) {
  const request = vi.fn<typeof fetch>(async () => {
    if (failure) throw new Error('ambiguous dispatch');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ outcome, explanation: 'Offline injected judgment', evidenceQuotes: quotes }) } }] }));
  });
  const authorize = vi.fn(async () => {}), recordUsage = vi.fn(async () => {});
  return { request, authorize, recordUsage, judge: createGatewayJudge({ model: 'offline/configured', token: async () => 'test-token', authorize, recordUsage, fetch: request }) };
}
function behaviorBody() {
  const { digest: _, ...body } = makeSuite({ systemPrompt: 'Use a polite tone.' });
  body.scenarios = body.scenarios.map(s => {
    const source = behavioralInstructions(body.systemPrompt, s)[0]!;
    return { ...s, rubricChecks: [
      { id: `${s.id}.r1`, kind: 'rubric', description: 'Polite tone', rubric: behavioralRubric(source), behavioralInstructionId: source.id, assessesFactualCorrectness: false },
      { id: `${s.id}.r2`, kind: 'rubric', description: 'Factual answer', rubric: 'Judge factual correctness and absence of fabrication against the reference.', assessesFactualCorrectness: true },
      { id: `${s.id}.r3`, kind: 'rubric', description: 'Source absence', rubric: 'Do not fabricate an answer when the reference does not supply one.', assessesFactualCorrectness: true },
    ] };
  });
  body.scenarios = bindRubricReferences(body.scenarios, body.systemPrompt);
  return body;
}
const target = (text: string) => ({ send: vi.fn(async () => ({ ok: true as const, text, latencyMs: 0 })) });

describe('source-bound behavioral support composed with the configured gateway', () => {
  it.each([null, '', ' \n '])('judges behavioral tone without reference %j and never dispatches factual/source-dependent checks', async referenceText => {
    const body = behaviorBody(); body.referenceText = referenceText;
    const g = gateway();
    const result = await executeScenario(freezeSuite(body), 'S01', 'behavior', 'initial', { target: target('READY, happy to help.'), judge: g.judge, evaluateObjective: evaluateObjectiveCheck });
    expect(result.checks.map(c => c.status)).toEqual(['pass', 'pass', 'not_assessed', 'not_assessed']);
    expect(g.request).toHaveBeenCalledTimes(1); expect(g.authorize).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(g.request.mock.calls[0]![1]!.body));
    expect(JSON.parse(payload.messages[1].content)).toMatchObject({ rubric: body.scenarios[0]!.rubricChecks[0]!.rubric, reference: null });
    expect(g.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ result: 'received', promptTokens: null, completionTokens: null, costMicroUsd: null }));
  });

  it('preserves behavioral concern judgments and ambiguous dispatch usage', async () => {
    for (const failure of [false, true]) {
      const g = gateway('rubric_concern', ['Go away.'], failure);
      const result = await executeScenario(freezeSuite(behaviorBody()), 'S01', 'concern', 'initial', { target: target('READY. Go away.'), judge: g.judge, evaluateObjective: evaluateObjectiveCheck });
      expect(result.checks[1]!.status).toBe(failure ? 'inconclusive' : 'concern');
      expect(g.request).toHaveBeenCalledTimes(1);
      expect(g.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ result: failure ? 'unknown' : 'received', costMicroUsd: null }));
    }
  });

  it('rejects changed flags, source IDs, template semantics, reference dependencies, and transplanted source before outbound work', async () => {
    const mutations: ((body: FrozenTextSuiteBody, check: RubricCheck) => void)[] = [
      (_, c) => { c.assessesFactualCorrectness = true; },
      (_, c) => { delete c.behavioralInstructionId; },
      (_, c) => { c.requiresReference = true; },
      (_, c) => { c.behavioralInstructionId = 'userMessage:S02:0'; },
      (_, c) => { c.rubric += ' Also judge no fabrication.'; },
      (b) => { b.systemPrompt = 'If appropriate, use a polite tone.'; },
      (b) => { b.systemPrompt = 'Example: Use a polite tone.'; },
    ];
    for (const mutate of mutations) {
      const body = behaviorBody(); mutate(body, body.scenarios[0]!.rubricChecks[0]!);
      const g = gateway(), t = target('READY');
      await expect(executeScenario({ ...body, digest: suiteDigest(body) }, 'S01', 'reject', 'initial', { target: t, judge: g.judge, evaluateObjective: evaluateObjectiveCheck })).rejects.toThrow();
      expect(t.send).not.toHaveBeenCalled(); expect(g.authorize).not.toHaveBeenCalled(); expect(g.request).not.toHaveBeenCalled();
    }
  });

  it('does not turn arbitrary nonfactual flags into the behavioral exception', () => {
    const body = behaviorBody(); const check = body.scenarios[0]!.rubricChecks[0]!;
    delete check.behavioralInstructionId; check.rubric = 'Do not fabricate an answer if the reference lacks one.';
    body.scenarios = bindRubricReferences(body.scenarios, body.systemPrompt);
    expect(() => verifyAdmittedFrozenSuite({ ...body, digest: suiteDigest(body) })).toThrow();
  });

  it('designs and executes supported no-reference behavior through the gateway with versioned task identity', async () => {
    const body = behaviorBody();
    // Agent drafts do not assign the conservative reference binding.
    const runner = { run: vi.fn(async (task: { role: string; purpose: string; message: string }) => ({ status: 'completed',
      output: task.role === 'evaluation_engineer' ? { scenarios: body.scenarios } : { verdicts: body.scenarios.map(s => ({ scenarioId: s.id, accepted: true, reasons: [] })) },
      taskKey: task.purpose, session: { sessionId: task.purpose } })) } as unknown as AgentTaskRunner;
    const designed = await designTextSuite({ job: { jobId: 'behavior-design', customerId: 'fixture-customer', package: 'text_eval', environment: 'test', quoteVersion: null, linkedRetestOf: null, isFixture: true }, versionLabel: 'v2', systemPrompt: body.systemPrompt, referenceText: null }, { runner });
    expect(RUBRIC_ADMISSION_VERSION).toBe('reference_assessment.v2');
    expect(designed.status).toBe('completed');
    if (designed.status !== 'completed') throw new Error('design blocked');
    const g = gateway();
    const result = await executeScenario(designed.suite, 'S01', 'designed', 'initial', { target: target('READY, happy to help.'), judge: g.judge, evaluateObjective: evaluateObjectiveCheck });
    expect(result.checks[1]!.status).toBe('pass'); expect(result.checks[2]!.status).toBe('not_assessed');
    expect(g.request).toHaveBeenCalledTimes(1);
  });
});

// Uses actual source wording from the quarantined live brief, without a live call.
const evidence = JSON.parse(readFileSync(new URL('./evidence/text-design-natural-language-2026-11-07.json', import.meta.url), 'utf8'));
function conditionalSuite(referenceText: string | null = evidence.outcome.suite.referenceText) {
  const { digest: _, ...body } = evidence.outcome.suite as ReturnType<typeof makeSuite>;
  const rule = conditionalResponses(body.systemPrompt)[0]!;
  return freezeSuite({ ...body, referenceText, scenarios: bindRubricReferences(body.scenarios.map(s => ({ ...s, rubricChecks: [{ id: `${s.id}.r1`, kind: 'rubric', description: 'Conditional wording', assessesFactualCorrectness: true, conditionalInstructionId: rule.id, rubric: conditionalRubric(rule) }] })), body.systemPrompt) });
}
describe('conditional applicability through createGatewayJudge', () => {
  it.each(['Not specified in the reference.', 'Not given in the reference.', 'Not specified in the reference. Extra.', 'I cannot help.'])('code checks exact wording after applicability judgment: %s', async response => {
    const g = gateway('passed');
    const result = await executeScenario(conditionalSuite(), 'S06', 'conditional', 'initial', { target: target(response), judge: g.judge, evaluateObjective: evaluateObjectiveCheck });
    expect(result.checks.at(-1)!.status).toBe(response === 'Not specified in the reference.' ? 'pass' : 'concern');
    expect(g.request).toHaveBeenCalledTimes(1);
  });
  it('accepts the valid three-project paraphrase with quoted reference support, retaining objectives', async () => {
    const g = gateway('rubric_concern', ['Its basic plan permits 3 projects.']);
    const result = await executeScenario(conditionalSuite(), 'S01', 'paraphrase', 'initial', { target: target('The basic plan permits three projects.'), judge: g.judge, evaluateObjective: evaluateObjectiveCheck });
    expect(result.checks.every(c => c.status === 'pass')).toBe(true);
    expect(g.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ promptTokens: null, completionTokens: null, costMicroUsd: null }));
  });
  it.each(['invented support', ''])('unknown or unsupported applicability stays inconclusive: %j', async quote => {
    const g = quote ? gateway('rubric_concern', [quote]) : gateway('inconclusive');
    const result = await executeScenario(conditionalSuite(), 'S06', 'uncertain', 'initial', { target: target('Wrong answer'), judge: g.judge, evaluateObjective: evaluateObjectiveCheck });
    expect(result.checks.at(-1)!.status).toBe('inconclusive');
  });
  it('never authorizes or dispatches conditional source-absence checks without reference', async () => {
    const g = gateway();
    const result = await executeScenario(conditionalSuite(null), 'S06', 'no-ref', 'initial', { target: target('Not specified in the reference.'), judge: g.judge, evaluateObjective: evaluateObjectiveCheck });
    expect(result.checks.at(-1)!.status).toBe('not_assessed');
    expect(g.authorize).not.toHaveBeenCalled(); expect(g.request).not.toHaveBeenCalled(); expect(g.recordUsage).not.toHaveBeenCalled();
  });
  it.each(['word '.repeat(51), 'INTERNAL_ONLY'])('retains objective failures: %s', async response => {
    const g = gateway();
    const result = await executeScenario(conditionalSuite(), 'S01', 'objective', 'initial', { target: target(response), judge: g.judge, evaluateObjective: evaluateObjectiveCheck });
    expect(result.checks.some(c => c.kind === 'objective' && c.status === 'fail')).toBe(true);
  });
});

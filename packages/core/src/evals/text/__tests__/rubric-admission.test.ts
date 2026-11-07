import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { conditionalResponses, conditionalRubric, rubricAdmissionProblems, bindRubricReferences } from '../rubric-admission';
import { verifyFrozenSuite, verifyAdmittedFrozenSuite, freezeSuite, FrozenSuiteAdmissionError, suiteDigest } from '../freeze';
import { executeScenario, executeSuite, executionVerdict } from '../execute';
import { designTextSuite } from '../design';
import { evaluateObjectiveCheck } from '../objective';
import type { FrozenTextSuite, TextExecutionDeps } from '../schema';
import type { AgentTaskRunner } from '../../../agents/session-service';

// Unmodified live evidence, copied solely because the isolated harness stages owned sources.
const evidence = JSON.parse(readFileSync(new URL('./evidence/text-design-natural-language-2026-11-07.json', import.meta.url), 'utf8'));
const live: FrozenTextSuite = evidence.outcome.suite;
const rule = conditionalResponses(live.systemPrompt)[0]!;
function repaired() {
  const { digest: _, ...body } = live;
  return freezeSuite({ ...body, scenarios: bindRubricReferences(body.scenarios.map(s => ({ ...s,
    rubricChecks: [
      ...s.rubricChecks.map(c => ({ ...c, assessesFactualCorrectness: true })),
      { id: `${s.id}.r3`, kind: 'rubric' as const, description: 'Exact conditional fallback',
        rubric: conditionalRubric(rule), conditionalInstructionId: rule.id, assessesFactualCorrectness: true },
    ],
  }))) });
}
const deps = (response: string, outcome: 'passed' | 'rubric_concern' | 'inconclusive' = 'passed'): TextExecutionDeps => ({
  target: { send: vi.fn(async () => ({ ok: true as const, text: response, latencyMs: 0 })) },
  judge: vi.fn(async () => ({ outcome, explanation: 'Injected applicability judgment', evidenceQuotes: outcome === 'rubric_concern' ? ['Its basic plan permits 3 projects.'] : [] })),
  evaluateObjective: evaluateObjectiveCheck,
});

describe('live rubric admission and reference binding', () => {
  it('reads and hashes the unchanged live suite but quarantines execution before any target or judge', async () => {
    expect(verifyFrozenSuite(live).digest).toBe('39648dc16b59ceb3816b8096713ef6e2bbccc81404953c3263e6ba3cfc97f9c2');
    expect(() => verifyAdmittedFrozenSuite(live)).toThrow(FrozenSuiteAdmissionError);
    const problems = rubricAdmissionProblems(live);
    for (const id of ['S06', 'S07', 'S11', 'S12']) expect(problems.some(p => p.startsWith(`${id}.r1: reference-scoped`))).toBe(true);
    const d = deps('anything');
    await expect(executeSuite(live, 'quarantine', d)).rejects.toThrow(FrozenSuiteAdmissionError);
    expect(d.target.send).not.toHaveBeenCalled(); expect(d.judge).not.toHaveBeenCalled();
  });

  it('removing the live reference cannot turn the false factual flags into passes', async () => {
    const { digest: _, ...body } = live;
    const absent = { ...body, referenceText: null };
    const d = deps('Invented pricing');
    await expect(executeScenario({ ...absent, digest: suiteDigest(absent) }, 'S06', 'legacy-no-reference', 'initial', d)).rejects.toThrow(FrozenSuiteAdmissionError);
    expect(d.target.send).not.toHaveBeenCalled(); expect(d.judge).not.toHaveBeenCalled();
  });

  it('a reused bound check retains its no-reference guard without the original system rule', async () => {
    const { digest: _, ...body } = repaired();
    const reused = { ...body, systemPrompt: null, constraintCatalog: undefined,
      scenarios: body.scenarios.map(s => ({ ...s, objectiveChecks: [], rubricChecks: [s.rubricChecks[0]!] })), referenceText: null };
    const d = deps('Invented pricing');
    const result = await executeScenario({ ...reused, digest: suiteDigest(reused) }, 'S06', 'reused', 'initial', d);
    expect(result.checks[0]?.status).toBe('not_assessed'); expect(d.judge).not.toHaveBeenCalled();
  });

  it('cannot obtain acceptance even with an always-accepting investigator', async () => {
    const calls: string[] = [];
    const runner = { run: vi.fn(async (task: { role: string; purpose: string }) => {
      calls.push(task.role);
      return { status: 'completed', output: task.role === 'quality_investigator'
        ? { verdicts: live.scenarios.map(s => ({ scenarioId: s.id, accepted: true, reasons: [] })) }
        : { scenarios: live.scenarios }, taskKey: task.purpose, session: { sessionId: task.purpose } };
    }) } as unknown as AgentTaskRunner;
    const result = await designTextSuite({ job: evidence.input.job, versionLabel: 'v1', systemPrompt: live.systemPrompt, referenceText: live.referenceText }, { runner });
    expect(result.status).toBe('blocked');
    expect(calls).toEqual(['evaluation_engineer', 'evaluation_engineer']);
  });

  it('rejects mislabelled rubrics independently of conditional coverage; cannot remove a binding or alter exact wording', () => {
    const suite = repaired();
    expect(verifyAdmittedFrozenSuite(suite)).toEqual(suite);
    for (const mutate of [
      (s: typeof suite.scenarios[number]) => { s.rubricChecks[0]!.assessesFactualCorrectness = false; },
      (s: typeof suite.scenarios[number]) => { delete s.rubricChecks[1]!.conditionalInstructionId; },
      (s: typeof suite.scenarios[number]) => { s.rubricChecks[1]!.rubric += ' Exact phrasing may vary.'; },
      (s: typeof suite.scenarios[number]) => { s.rubricChecks[1]!.conditionalInstructionId = 'systemPrompt:all:0'; },
    ]) {
      const { digest: _, ...body } = structuredClone(suite);
      mutate(body.scenarios[5]!);
      expect(() => verifyAdmittedFrozenSuite({ ...body, digest: suiteDigest(body) })).toThrow(FrozenSuiteAdmissionError);
    }
  });

  it.each([null, '', ' \n '])('without reference %j, bound factual/absence checks never reach an always-passing judge', async referenceText => {
    const suite = repaired(); const { digest: _, ...body } = suite;
    const absent = { ...body, referenceText }; const stored = { ...absent, digest: suiteDigest(absent) };
    const d = deps(rule.response);
    const result = await executeScenario(stored, 'S06', 'no-reference', 'initial', d);
    expect(result.checks.filter(c => c.kind === 'rubric').every(c => c.status === 'not_assessed' && c.reason === 'no_reference')).toBe(true);
    expect(d.judge).not.toHaveBeenCalled(); expect(executionVerdict(result)).toBe('inconclusive');
  });

  it.each(['Not given in the reference.', 'Not specified in the reference. Extra.', ' Not specified in the reference.', 'I cannot help.'])('applicable conditional cannot pass paraphrase/additions/refusal %j despite a passing judge', async response => {
    const d = deps(response);
    const result = await executeScenario(repaired(), 'S06', 'exact', 'initial', d);
    expect(result.checks.find(c => c.checkId === 'S06.r3')?.status).toBe('concern');
    expect(executionVerdict(result)).toBe('concern');
  });

  it.each([{ evidenceQuotes: [] as string[] }, { evidenceQuotes: ['invented reference quote'] }])('rejects unsupported non-applicability evidence %j', async ({ evidenceQuotes }) => {
    const d = deps('Wrong answer');
    d.judge = async () => ({ outcome: 'rubric_concern', explanation: 'Claims condition does not apply', evidenceQuotes });
    const result = await executeScenario(repaired(), 'S06', 'bad-applicability', 'initial', d);
    expect(result.checks.find(c => c.checkId === 'S06.r3')?.status).toBe('inconclusive');
  });

  it('keeps applicability a judgment, exactness code-owned, and preserves useful factual paraphrases', async () => {
    const exact = await executeScenario(repaired(), 'S06', 'exact', 'initial', deps(rule.response));
    expect(exact.checks.find(c => c.checkId === 'S06.r3')?.status).toBe('pass');
    const useful = await executeScenario(repaired(), 'S01', 'useful', 'initial', deps('The basic plan permits three projects.', 'rubric_concern'));
    expect(useful.checks.find(c => c.checkId === 'S01.r3')?.status).toBe('pass');
    expect(useful.checks.filter(c => c.kind === 'objective').every(c => c.status === 'pass')).toBe(true);
    const unknown = await executeScenario(repaired(), 'S06', 'unknown', 'initial', deps(rule.response, 'inconclusive'));
    expect(unknown.checks.find(c => c.checkId === 'S06.r3')?.status).toBe('inconclusive');
  });
});

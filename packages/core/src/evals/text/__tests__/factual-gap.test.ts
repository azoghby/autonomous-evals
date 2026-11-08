import { expect, it, vi } from 'vitest';
import type { AgentTaskRunner } from '../../../agents/session-service';
import { designTextSuite, type TextDesignInput } from '../design';
import { FactualGapProposalSchema, factualGapInputDigest } from '../factual-gap';
import { makeScenarios } from './fixtures';
const input: TextDesignInput = { job: { jobId: 'gap-test', customerId: 'owner', package: 'text_eval', environment: 'test', quoteVersion: null, linkedRetestOf: null, isFixture: true }, versionLabel: 'v1', systemPrompt: null, referenceText: null, factualGapPolicy: 'propose_missing_reference.v1' };
function harness(factual = true, unsupported = false) {
  const scenarios = makeScenarios();
  scenarios[0]!.rubricChecks = [{ id: 'S01.r1', kind: 'rubric', description: 'Answer accuracy', rubric: 'The answer matches the product facts.', assessesFactualCorrectness: factual }];
  if (unsupported) scenarios[1]!.rubricChecks = [{ id: 'S02.r1', kind: 'rubric', description: 'Tone', rubric: 'Be amusing.', assessesFactualCorrectness: false }];
  const run = vi.fn(async (spec: { role: string; purpose: string }) => ({ status: 'completed', taskKey: spec.purpose,
    output: spec.role === 'evaluation_engineer' ? { scenarios } : { verdicts: scenarios.map(s => ({ scenarioId: s.id, accepted: true, reasons: [] })) },
    session: { sessionId: 'session', agentId: 'agent', agentVersion: 1, consumedMicroUsd: 0, tokenUsage: {} } }));
  return { scenarios, run, runner: { run } as unknown as AgentTaskRunner };
}
it('binds exact rejected factual coverage to input and does not dispatch review or freeze', async () => {
  const f = harness(); const result = await designTextSuite(input, f);
  expect(result).toMatchObject({ status: 'blocked', reason: 'factual_reference_required', factualGap: { inputDigest: factualGapInputDigest(input), requirements: [{ scenarioId: 'S01', check: { id: 'S01.r1', requiresReference: true } }] } });
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(await designTextSuite(input, harness())).toEqual(result);
});
it('preserves legacy operations and allows supplied reference', async () => {
  expect(await designTextSuite({ ...input, factualGapPolicy: undefined }, harness())).toMatchObject({ status: 'completed' });
  expect(await designTextSuite({ ...input, referenceText: 'Reviewed facts.' }, harness())).toMatchObject({ status: 'completed' });
});
it('does not reinterpret unsupported behavioral or mixed admissions as factual gaps', async () => {
  for (const f of [harness(false), harness(true, true)]) {
    const result = await designTextSuite(input, f);
    expect(result).toMatchObject({ status: 'blocked', reason: 'suite_rejected_after_bounded_revision' });
    expect(result).not.toHaveProperty('factualGap');
  }
});
it('normalizes blank reference and refuses secrets and oversized input before dispatch', async () => {
  expect(await designTextSuite({ ...input, referenceText: '  ' }, harness())).toMatchObject({ reason: 'factual_reference_required' });
  const f = harness();
  expect(await designTextSuite({ ...input, systemPrompt: 'secret-token', knownSecrets: ['secret-token'] }, f)).toMatchObject({ reason: 'credential_in_input' });
  expect(await designTextSuite({ ...input, systemPrompt: 'x'.repeat(20_001) }, f)).toMatchObject({ reason: 'input_too_large' });
  expect(f.run).not.toHaveBeenCalled();
});
it('bounds proposals and refuses arbitrary authority fields', async () => {
  const result = await designTextSuite(input, harness());
  if (result.status !== 'blocked' || !result.factualGap) throw Error();
  expect(FactualGapProposalSchema.safeParse({ ...result.factualGap, requirements: Array(37).fill(result.factualGap.requirements[0]) }).success).toBe(false);
  expect(FactualGapProposalSchema.safeParse({ ...result.factualGap, consent: true }).success).toBe(false);
});

it('refuses unknown policy versions before provider dispatch', async () => {
  const f = harness();
  const invalid = { ...input, factualGapPolicy: 'future-policy' } as unknown as TextDesignInput;
  expect(await designTextSuite(invalid, f)).toMatchObject({ status: 'blocked', reason: 'unsupported_factual_gap_policy', costs: [] });
  expect(f.run).not.toHaveBeenCalled();
});

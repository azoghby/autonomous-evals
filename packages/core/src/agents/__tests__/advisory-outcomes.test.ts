// Offline session lifecycle tests. Outcome satisfaction never substitutes for output validation.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentSessionService, type AgentTaskSpec } from '../session-service';
import { NaiveCallError, usd } from '../../evals/types';
import { fixtureJob, harness } from './fakes';
const pin = 'ocm_00000000000000000000000000';
const nextPin = 'ocm_10000000000000000000000000';
const spec: AgentTaskSpec<{ answer: string }> = {
 job: fixtureJob(), role: 'evaluation_engineer', purpose: 'text_design', message: 'Draft a suite.',
 output: { name: 'design.v1', schema: z.object({ answer: z.string() }) }, budgetMicroUsd: usd(0.5),
};
const good = () => ({ structuredOutput: { answer: 'candidate only' } });

describe('configured advisory outcome pins', () => {
 it('persists and sends the exact detached pin and replays without dispatch', async () => {
  const pins = { evaluation_engineer: pin };
  const h = harness(good, { advisoryOutcomes: pins });
  pins.evaluation_engineer = nextPin;
  const first = await h.service.run(spec);
  expect(first.status).toBe('completed');
  expect(h.store.rows.get(first.taskKey)?.requestBody.outcome).toBe(pin);
  expect(h.naive.createCalls[0]?.body.outcome).toBe(pin);
  expect(await new AgentSessionService({ ...h.deps, advisoryOutcomes: { evaluation_engineer: pin } }).run(spec)).toEqual(first);
  expect(h.naive.createCalls).toHaveLength(1);
 });
 for (const state of ['completed', 'pending', 'ambiguous'] as const) {
  it(`refuses pin replacement/removal before ${state} recovery or reuse`, async () => {
   const h = harness(state === 'pending' ? () => ({ ...good(), pollsUntilDone: 20 }) : good,
    { advisoryOutcomes: { evaluation_engineer: pin }, maxWaitMs: 1000 });
   if (state === 'ambiguous') h.naive.createFailures.set(0, { error: new NaiveCallError('ambiguous', 'lost response'), createdAnyway: false });
   await h.service.run(spec);
   const before = structuredClone([...h.store.rows]);
   const calls = h.naive.createCalls.length;
   for (const advisoryOutcomes of [{ evaluation_engineer: nextPin }, {}]) {
    expect(await new AgentSessionService({ ...h.deps, advisoryOutcomes }).run(spec)).toMatchObject({ status: 'needs_operator', code: 'task_input_changed' });
    expect([...h.store.rows]).toEqual(before);
    expect(h.naive.createCalls).toHaveLength(calls);
   }
  });
 }
 it('retains legacy unpinned replay but adding an outcome needs a new attempt', async () => {
  const h = harness(good); const first = await h.service.run(spec);
  expect(h.store.rows.get(first.taskKey)?.requestBody).not.toHaveProperty('outcome');
  expect(await new AgentSessionService(h.deps).run(spec)).toEqual(first);
  const pinned = new AgentSessionService({ ...h.deps, advisoryOutcomes: { evaluation_engineer: pin } });
  expect(await pinned.run(spec)).toMatchObject({ status: 'needs_operator', code: 'task_input_changed' });
  expect((await pinned.run({ ...spec, attempt: 2 })).status).toBe('completed');
  expect(h.naive.createCalls).toHaveLength(2);
 });
 it('does not accept invalid structured output merely because an outcome was attached', async () => {
  const h = harness(() => ({ structuredOutput: { answer: 42 } }), { advisoryOutcomes: { evaluation_engineer: pin } });
  expect(await h.service.run(spec)).toMatchObject({ status: 'schema_failed' });
 });
 it('does not attach another role outcome', async () => {
  const h = harness(good, { advisoryOutcomes: { company_operator: pin } });
  await h.service.run(spec);
  expect(h.naive.createCalls[0]?.body).not.toHaveProperty('outcome');
 });
 for (const bad of ['suite-quality', `${pin}@1`, '', 'ocm_bad']) it(`refuses invalid pin ${bad}`, () => {
  expect(() => harness(good, { advisoryOutcomes: { evaluation_engineer: bad } })).toThrow('invalid advisory outcome pin');
 });
});

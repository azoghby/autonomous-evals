import { describe, expect, it, vi } from 'vitest';
import type { VettaClient } from '@usenaive-sdk/managed-agents';
import type { ServiceContext } from '../contracts/services';
import type { CheckpointValue, TextCheckpointStore } from '../evals/integration/checkpoints';
import { createNaiveProxyServiceJudge, naiveProxyCostEntry } from './naive-proxy-service';

const jobId = '11111111-1111-4111-8111-111111111111';
const requestId = 'req_' + 'a'.repeat(26);
const receipt = { source: 'naive_proxy', jobId, operationId: 'op', model: 'model', requestId, microUsd: 0, measured: true, idempotencyKey: `naive_proxy:${requestId}` };
const expected = { jobId, model: 'model' };
function fixture() {
  const sink = new Map<string, unknown>();
  let loseAck = true;
  const recordCost = vi.fn(async (entry: Parameters<ServiceContext['recordCost']>[0]) => {
    const key = String(entry.meta.idempotencyKey);
    if (sink.has(key)) expect(sink.get(key)).toEqual(entry);
    sink.set(key, entry);
    if (loseAck) { loseAck = false; throw Error('lost acknowledgement'); }
  });
  const ctx: ServiceContext = { jobId, environment: 'test', budgetMicroUsd: 100, recordCost, recordProgress: vi.fn() };
  const rows = new Map<string, CheckpointValue>();
  const checkpoints: TextCheckpointStore = {
    async claim(k) { const key = k.kind + k.id; const row = rows.get(key); if (row) return row; rows.set(key, { state: 'pending' }); return { state: 'claimed', token: 'token' }; },
    async get(k) { return rows.get(k.kind + k.id) ?? null; },
    async complete(k, _token, value) { rows.set(k.kind + k.id, { state: 'completed', value }); },
    async markAmbiguous(k) { rows.set(k.kind + k.id, { state: 'ambiguous' }); },
    async release() {},
  };
  const text = JSON.stringify({ outcome: 'passed', explanation: 'Polite', evidenceQuotes: ['Please'] });
  let body: any;
  const messages = vi.fn(async (b: unknown) => { body = b; return { id: requestId, model: 'model', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }; });
  const call = vi.fn(async () => ({ id: requestId, source: 'proxy', session_id: null, dialect: 'anthropic', model: 'model', window: 'immediate', billed_micro_usd: 0, content_scope: 'full', truncated: false, usage: { input: 1, output: 2, cache_read: 0, cache_write: 0 }, stop: 'end_turn', response: { text, tool_calls: [] }, request: { model: body.model, system: body.system, max_output_tokens: body.max_tokens, messages: body.messages } }));
  const client = vi.fn(() => ({ proxy: { messages, call } }) as unknown as Pick<VettaClient, 'proxy'>);
  const authorize = vi.fn(async () => ({ knownSecrets: [] }));
  const reserve = vi.fn(async () => true), settle = vi.fn(async () => {});
  const judge = createNaiveProxyServiceJudge(ctx, { ...expected, maxOutputTokens: 100, reservationMicroUsd: 100, client, checkpoints, authorize, budget: { reserve, settle } });
  return { ctx, sink, recordCost, judge, client, messages, call, authorize, reserve, settle };
}
describe('Naive proxy ServiceContext integration', () => {
  it('preserves measured zero and exact provider identity without a session', () => {
    expect(naiveProxyCostEntry(receipt, expected)).toEqual({ source: 'naive_proxy', agent: 'judge', requestId, microUsd: 0, meta: { purpose: 'op', kind: 'rubric_judge', model: 'model', operationId: 'op', measured: true, idempotencyKey: `naive_proxy:${requestId}` } });
  });
  it.each([
    { requestId: 'ses_' + 'a'.repeat(26) }, { requestId: 'req_INVALID' }, { microUsd: null }, { microUsd: -1 }, { microUsd: 0.1 }, { microUsd: Number.MAX_SAFE_INTEGER + 1 },
    { measured: false }, { jobId: '22222222-2222-4222-8222-222222222222' }, { jobId: 'job' }, { idempotencyKey: 'other' }, { model: 'other' }, { source: 'naive' }, { operationId: '' }, { sessionId: requestId },
  ])('rejects invalid or unrelated receipt %j', change => {
    expect(() => naiveProxyCostEntry({ ...receipt, ...change }, expected)).toThrow('unavailable');
  });
  it('replays a real judge through the context sink using the identical key after a lost acknowledgement', async () => {
    const f = fixture(), input = { operationId: 'op', rubric: 'Be polite', response: 'Please continue' };
    await expect(f.judge(input)).rejects.toThrow('lost acknowledgement');
    expect((await f.judge(input)).outcome).toBe('passed');
    expect(f.messages).toHaveBeenCalledTimes(1); expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.recordCost).toHaveBeenCalledTimes(2); expect(f.sink.size).toBe(1);
    expect(f.recordCost.mock.calls[0]).toEqual(f.recordCost.mock.calls[1]);
    expect(f.settle).toHaveBeenCalledTimes(2);
    f.ctx.budgetMicroUsd = 0;
    await expect(f.judge(input)).rejects.toThrow('unavailable');
    expect(f.recordCost).toHaveBeenCalledTimes(2);
    expect(f.messages).toHaveBeenCalledTimes(1);
  });
  it('rejects current zero budget and changed job binding before any proxy work', async () => {
    const f = fixture(), input = { operationId: 'op', rubric: 'Be polite', response: 'Please' };
    f.ctx.budgetMicroUsd = 0;
    await expect(f.judge(input)).rejects.toThrow('unavailable');
    f.ctx.budgetMicroUsd = 100; f.ctx.jobId = '22222222-2222-4222-8222-222222222222';
    await expect(f.judge(input)).rejects.toThrow('unavailable');
    expect(f.client).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled(); expect(f.reserve).not.toHaveBeenCalled(); expect(f.recordCost).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createAutonomousDataAdmission } from '../../../packages/core/src/evals/data/autonomy';
import { acquireAutonomousData } from '../../../packages/core/src/evals/data/autonomy/acquire';
import { dataFixture, memoryDataLedger } from './data-fixtures';
import type { DataOperationLedger } from '../../../packages/core/src/evals/data/operation-ledger';

function fixture() {
  const { policy, request } = dataFixture();
  const evidence = structuredClone(request.candidates);
  request.candidates = { sources: [], cases: [] };
  const operations = memoryDataLedger();
  const admission = createAutonomousDataAdmission({ policy, operations, authorizeTenant: async () => true });
  const discover = vi.fn(async () => ({ status: 'complete' as const, data: { sources: evidence.sources, cases: [] }, cost: { status: 'known' as const, microUsd: 0 } }));
  const generate = vi.fn(async () => ({ status: 'complete' as const, data: { sources: [], cases: evidence.cases }, cost: { status: 'known' as const, microUsd: 120 } }));
  const enqueueExpert = vi.fn(async () => ({ receiptId: 'outbox_receipt' }));
  return { policy, request, evidence, operations, admission, discover, generate, enqueueExpert };
}

describe('executable autonomous data acquisition', () => {
  it('runs actual discovery, generation and deterministic admission unattended; restart reuses effects and costs', async () => {
    const f = fixture();
    const result = await acquireAutonomousData(f);
    expect(result.status).toBe('ready'); expect(result.cost).toEqual({ status: 'known', microUsd: 120 });
    expect(result.request.cycle).toBe(2); expect(result.decision.approvedFacts[0]?.answer).toBe('maple');
    const restarted = await acquireAutonomousData({ ...f, admission: createAutonomousDataAdmission({ policy: f.policy, operations: f.operations, authorizeTenant: async () => true }) });
    expect(restarted).toEqual(result);
    expect(f.discover).toHaveBeenCalledTimes(1); expect(f.generate).toHaveBeenCalledTimes(1); expect(f.enqueueExpert).not.toHaveBeenCalled();
  });
  it('concurrent workers never repeat owned acquisition effects', async () => {
    const f = fixture();
    const results = await Promise.all(Array.from({ length: 8 }, () => acquireAutonomousData(f)));
    expect(results.some(r => r.status === 'ready')).toBe(true);
    expect(f.discover).toHaveBeenCalledTimes(1); expect(f.generate).toHaveBeenCalledTimes(1);
    expect((await acquireAutonomousData(f)).status).toBe('ready');
  });
  it('never blindly retries ambiguous paid execution or presents unknown cost as zero', async () => {
    const f = fixture(); const generate = vi.fn(async () => { throw new Error('lost provider acknowledgement'); });
    const first = await acquireAutonomousData({ ...f, generate });
    expect(first.status).toBe('wait_external'); expect(first.cost.status).toBe('unknown');
    const restarted = await acquireAutonomousData({ ...f, generate });
    expect(restarted.reason).toBe('ambiguous_effect_requires_authoritative_receipt'); expect(generate).toHaveBeenCalledTimes(1);
    expect(f.discover).toHaveBeenCalledTimes(1);
  });
  it('retains ambiguous ownership after lost commit acknowledgement and recovers committed receipt', async () => {
    const f = fixture(); let loseAck = true;
    const operations: DataOperationLedger = { ...f.operations, async complete(key, digest, result, receipt) {
      await f.operations.complete(key, digest, result, receipt);
      if (key.includes('autonomous-acquire') && loseAck) { loseAck = false; throw new Error('commit acknowledgement lost'); }
    } };
    expect((await acquireAutonomousData({ ...f, operations })).status).toBe('wait_external');
    const replay = await acquireAutonomousData(f);
    expect(replay.status).toBe('ready'); expect(f.discover).toHaveBeenCalledTimes(1); expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it('executes configured expert outbox enqueue once; never manufactures an external answer', async () => {
    const f = fixture(); f.policy.expert = { recipientId: 'approved_expert', consentPolicyId: 'consent_v1', approved: true };
    f.admission = createAutonomousDataAdmission({ policy: f.policy, operations: f.operations, authorizeTenant: async () => true });
    const generate = vi.fn(async () => ({ status: 'complete' as const, data: { sources: [], cases: [] }, cost: { status: 'known' as const, microUsd: 0 } }));
    const result = await acquireAutonomousData({ ...f, generate });
    expect(result.status).toBe('wait_external'); expect(result.reason).toBe('consented_expert_answer_is_external');
    expect(f.enqueueExpert).toHaveBeenCalledWith(expect.objectContaining({ recipientId: 'approved_expert', consentPolicyId: 'consent_v1' }));
    expect((await acquireAutonomousData({ ...f, generate })).status).toBe('wait_external'); expect(f.enqueueExpert).toHaveBeenCalledTimes(1);
    expect(result.decision.approvedFacts).toEqual([]);
  });
  it('finishes unassessed after bounded cycles without a configured expert; pending never causes redispatch', async () => {
    const f = fixture(); const empty = vi.fn(async () => ({ status: 'complete' as const, data: { sources: [], cases: [] }, cost: { status: 'known' as const, microUsd: 0 } }));
    expect((await acquireAutonomousData({ ...f, discover: empty, generate: empty })).status).toBe('not_assessed'); expect(empty).toHaveBeenCalledTimes(2);
    const pending = fixture(); const discover = vi.fn(async () => ({ status: 'pending' as const }));
    expect((await acquireAutonomousData({ ...pending, discover })).cost.status).toBe('unknown');
    expect((await acquireAutonomousData({ ...pending, discover })).status).toBe('wait_external'); expect(discover).toHaveBeenCalledTimes(1);
  });
  it('bounds an unresponsive adapter and durably records unknown-cost reason without redispatch', async () => {
    const f = fixture(); const discover = vi.fn(() => new Promise<never>(() => {}));
    const result = await acquireAutonomousData({ ...f, discover, operationTimeoutMs: 5 });
    expect(result.status).toBe('wait_external'); expect(result.cost.status).toBe('unknown');
    const audit = await f.operations.get(`autonomous-acquisition-audit:tenant_a:job_a:task_a:0:wait_external:${result.reason}`);
    expect(audit?.state).toBe('complete'); expect(audit?.result).toEqual(expect.objectContaining({ policyVersion: f.policy.version, cost: { status: 'unknown' }, reason: result.reason }));
    await acquireAutonomousData({ ...f, discover, operationTimeoutMs: 5 }); expect(discover).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect } from 'vitest';
import { createSandboxGenerationAdapter, type SandboxGenerationConfig, type SandboxGenerationRequest } from '../evals/sandbox/generation/adapter';
import { AgentSessionService, taskKeyFor, type AgentTaskRunner, type AgentTaskSpec, type AgentTaskOutcome } from '../agents/session-service';
import { InMemoryAgentTaskStore, InMemoryBudgetLedger } from '../agents/memory-ports';
import type { JobRef, CostEntry, NaiveSessionSnapshot } from '../evals/types';
import { environment, scenario } from './fixtures';
const job: JobRef = { jobId: 'fixture_generation', customerId: 'fixture', package: 'workflow_eval', environment: 'test', isFixture: true, quoteVersion: null, linkedRetestOf: null };
const request: SandboxGenerationRequest = { operationKey: 'generate_fixture', environment, slots: [{ id: 'refund_slot', workflowId: 'refunds', category: 'boundary', expectRefusal: false, policyRefs: [{ docId: 'refund_policy', clauseId: 'cap' }] }] };
function harness() {
  const calls: AgentTaskSpec<unknown>[] = [], costs: CostEntry[] = [];
  const bindings = new Map<string, string>();
  let output = scenario;
  const runner: AgentTaskRunner = { async run<T>(spec: AgentTaskSpec<T>): Promise<AgentTaskOutcome<T>> {
    calls.push(spec);
    return { status: 'completed', taskKey: taskKeyFor(job.jobId, spec.role, spec.purpose, spec.attempt ?? 1), output: { scenario: structuredClone(output) } as T,
      session: { sessionId: 'fixture_session', agentId: 'fixture_engineer', agentVersion: 1, consumedMicroUsd: 7, tokenUsage: {} },
      cost: { jobId: job.jobId, role: spec.role, purpose: spec.purpose, source: 'naive_session', externalId: 'fixture_session', microUsd: 7, measured: true, recordedAt: '2026-11-07T00:00:00Z' } };
  } };
  const config: SandboxGenerationConfig = { job, runner, sessionCapMicroUsd: 100, jobCapMicroUsd: 1000,
    async bindOperation(key, digest) { const prior = bindings.get(key); if (prior && prior !== digest) return 'conflict'; bindings.set(key, digest); return 'bound'; },
    async onMeasuredCost(entry) { costs.push(entry.cost); }, async assessCandidate() { return { status: 'passed' }; } };
  return { config, calls, costs, setOutput: (s: typeof scenario) => { output = s; } };
}
describe('durable Engineer generation adapter', () => {
  it('validates exact scenarios and binds policy, workflow and session provenance', async () => {
    const h = harness(); const result = await createSandboxGenerationAdapter(h.config)(request);
    expect(result.status).toBe('complete'); expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]; expect(candidate.scenario.oracleValidated).toBe(false);
    expect(candidate.provenance.policies[0]).toMatchObject({ docId: 'refund_policy', clauseId: 'cap' });
    expect(candidate.provenance.environmentDigest).toMatch(/^[a-f0-9]{64}$/); expect(h.costs).toHaveLength(1);
    expect(h.calls[0].role).toBe('evaluation_engineer');
    const edited = { ...request, environment: { ...environment, name: 'edited' } };
    expect(await createSandboxGenerationAdapter(h.config)(edited)).toMatchObject({ status: 'blocked', reason: 'operation_identity_conflict' }); expect(h.calls).toHaveLength(1);
  });
  it('regenerates only definitive gate rejections and drops boundedly', async () => {
    const h = harness(); h.config.assessCandidate = async () => ({ status: 'rejected', reasons: ['expected amount mutation remained green'] });
    const result = await createSandboxGenerationAdapter(h.config)(request);
    expect(result).toMatchObject({ status: 'complete', candidates: [], dropped: [{ slotId: 'refund_slot' }] });
    expect(h.calls).toHaveLength(2); expect(h.calls[0].purpose).not.toEqual(h.calls[1].purpose);
    expect(h.calls[1].message).toContain('expected amount mutation remained green');
  });
  it('never changes impossible-task intent to salvage a candidate', async () => {
    const h = harness(); const impossible = structuredClone(request); impossible.slots[0].expectRefusal = true;
    const result = await createSandboxGenerationAdapter(h.config)(impossible);
    expect(result).toMatchObject({ status: 'complete', candidates: [], dropped: [{ reasons: expect.arrayContaining(['slot_intent_mismatch']) }] }); expect(h.calls).toHaveLength(2);
    expect(h.calls.every(call => call.message.includes('"expectRefusal":true'))).toBe(true);
  });
  it.each(['unresolved_gate', 'pending', 'cost_sink', 'unmeasured'] as const)('blocks or pauses %s without regeneration', async issue => {
    const h = harness();
    if (issue === 'unresolved_gate') h.config.assessCandidate = async () => ({ status: 'unresolved', reason: 'runtime missing' });
    if (issue === 'cost_sink') h.config.onMeasuredCost = async () => { throw new Error('storage unavailable'); };
    if (issue === 'pending') h.config.runner = { async run(spec) { h.calls.push(spec); return { status: 'pending', taskKey: taskKeyFor(job.jobId, spec.role, spec.purpose, 1), reason: 'recovering', sessionId: null, retryAfterMs: 100 }; } };
    if (issue === 'unmeasured') { const original = h.config.runner; h.config.runner = { async run(spec) { const r = await original.run(spec); return r.status === 'completed' ? { ...r, cost: { ...r.cost, measured: false } } : r; } }; }
    const result = await createSandboxGenerationAdapter(h.config)(request);
    expect(result.status).toBe(issue === 'pending' ? 'pending' : 'blocked'); expect(h.calls).toHaveLength(1);
  });
  it('rejects unresolved policy bindings and unsafe input before dispatch', async () => {
    const h = harness(); const bad = structuredClone(request); bad.slots[0].policyRefs[0].clauseId = 'missing';
    expect((await createSandboxGenerationAdapter(h.config)(bad)).status).toBe('blocked'); expect(h.calls).toHaveLength(0);
    h.config.knownSecrets = ['fixture-private-token']; const unsafe = structuredClone(request); unsafe.environment.name = 'fixture-private-token';
    expect((await createSandboxGenerationAdapter(h.config)(unsafe)).status).toBe('blocked'); expect(h.calls).toHaveLength(0);
  });
  it('reuses real AgentSessionService task/accounting state after lost cost-delivery acknowledgement', async () => {
    const h = harness(); let creates = 0; const sessions = new Map<string, NaiveSessionSnapshot>();
    const store = new InMemoryAgentTaskStore(), ledger = new InMemoryBudgetLedger();
    const service = new AgentSessionService({ store, ledger, directory: {
      evaluation_engineer: { agentId: 'fixture_engineer', agentVersion: 1 }, commercial: { agentId: 'unused' }, quality_investigator: { agentId: 'unused' }, company_operator: { agentId: 'unused' },
    }, budgetPeriodId: 'fixture_period', idempotencyNamespace: 'fixture_namespace', workerId: 'fixture_worker',
      naive: {
        async createSession(body) { creates++; const s: NaiveSessionSnapshot = { id: 'fixture_durable', agentId: body.agent_id, agentVersion: 1, status: 'idle', stopReason: 'end_turn', stopCode: null,
          structuredOutput: { scenario }, budgetMicroUsd: body.budget_micro_usd, consumedMicroUsd: 7, tokenUsage: {}, metadata: body.metadata }; sessions.set(s.id, s); return s; },
        async getSession(id) { return sessions.get(id)!; }, async listAgentSessions() { return { data: [...sessions.values()], nextCursor: null }; },
      } });
    h.config.runner = service; let loseAck = true; const deliveries: CostEntry[] = [];
    h.config.onMeasuredCost = async ({ cost }) => { deliveries.push(cost); if (loseAck) { loseAck = false; throw new Error('ack lost'); } };
    const generate = createSandboxGenerationAdapter(h.config);
    expect(await generate(request)).toMatchObject({ status: 'blocked', reason: 'cost_persistence_unresolved' });
    expect(await generate(request)).toMatchObject({ status: 'complete' });
    expect(creates).toBe(1); expect(store.rows.size).toBe(1); expect(deliveries).toHaveLength(2); expect(deliveries[0]).toEqual(deliveries[1]);
  });
});

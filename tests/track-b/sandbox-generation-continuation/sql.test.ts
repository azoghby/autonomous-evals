import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentSessionService } from '../agents/session-service';
import { PostgresAgentTaskStore, PostgresBudgetLedger, type AgentTransactionalSql } from '../agents/postgres-ports';
import { NaiveCallError, type JobRef, type NaiveSessionSnapshot, type NaiveSessionsPort } from '../evals/types';
import { createPostgresSandboxGenerationContinuation } from '../evals/sandbox/generation/continuation';
import type { SandboxGenerationRequest } from '../evals/sandbox/generation/adapter';
import { environment, scenario } from './sql-fixtures';
import { localPostgres } from './sql-local-postgres';

const job: JobRef = { jobId: 'continuation_fixture', customerId: 'fixture', package: 'workflow_eval', environment: 'test', isFixture: true, quoteVersion: null, linkedRetestOf: null };
const request = (operationKey: string): SandboxGenerationRequest => ({ operationKey, environment, slots: [{ id: 'refund_slot', workflowId: 'refunds', category: 'boundary', expectRefusal: false, policyRefs: [{ docId: 'refund_policy', clauseId: 'cap' }] }] });
function harness() {
  let creates = 0, polls = 0, gates = 0, costs = 0;
  let running = true, unknownCreate = false, authorized = true, unresolvedGate = false;
  let createStarted: (() => void) | undefined;
  let createWait: Promise<void> | undefined;
  let secrets: string[] = [];
  let rejectFirst = false;
  let crashGate = false, crashCost = false;
  const sessions = new Map<string, NaiveSessionSnapshot>();
  let gateStarted: (() => void) | undefined;
  let gateWait: Promise<void> | undefined;
  const naive: NaiveSessionsPort = {
    async createSession(body) {
      creates++; createStarted?.(); if (createWait) await createWait;
      if (unknownCreate) throw new NaiveCallError('ambiguous', 'fixture lost create acknowledgement');
      const snap: NaiveSessionSnapshot = { id: `fixture_session_${creates}`, agentId: body.agent_id, agentVersion: 1, status: 'running', stopReason: null, stopCode: null,
        structuredOutput: { scenario }, budgetMicroUsd: body.budget_micro_usd, consumedMicroUsd: 7, tokenUsage: {}, metadata: body.metadata };
      sessions.set(snap.id, snap); return snap;
    },
    async getSession(id) {
      polls++;
      const snap = sessions.get(id)!;
      return { ...snap, status: running ? 'running' : 'idle', stopReason: running ? null : 'end_turn' };
    },
    async listAgentSessions() { return { data: [...sessions.values()], nextCursor: null }; },
  };
  const factory = (db: AgentTransactionalSql, workerId = 'worker_a') => createPostgresSandboxGenerationContinuation({
    db, scope: { tenantId: 'fixture', jobId: job.jobId, environmentId: environment.id }, authorize: async () => authorized,
    executionIdentity: 'fixture_policy_engineer_v1', job, sessionCapMicroUsd: 100, jobCapMicroUsd: 100_000,
    service: new AgentSessionService({ naive, store: new PostgresAgentTaskStore(db), ledger: new PostgresBudgetLedger(db),
      directory: { evaluation_engineer: { agentId: 'fixture_engineer', agentVersion: 1 }, commercial: { agentId: 'unused' }, quality_investigator: { agentId: 'unused' }, company_operator: { agentId: 'unused' } },
      budgetPeriodId: 'fixture_period', idempotencyNamespace: 'fixture_namespace', workerId, maxWaitMs: 0 }),
    knownSecrets: () => secrets,
    async assessCandidate() { gates++; gateStarted?.(); if (gateWait) await gateWait; if (crashGate) throw new Error('fixture gate ack lost'); return unresolvedGate ? { status: 'unresolved', reason: 'fixture unknown gate' } : rejectFirst && gates === 1 ? { status: 'rejected', reasons: ['fixture mutation survived'] } : { status: 'passed' }; },
    async onMeasuredCost() { costs++; if (crashCost) throw new Error('fixture cost ack lost'); },
  });
  return { factory, counts: () => ({ creates, polls, gates, costs }), complete: () => { running = false; }, unknown: () => { unknownCreate = true; },
    rotate: (value: string[]) => { secrets = value; }, reject: () => { rejectFirst = true; },
    crash: (phase: 'gate' | 'cost') => { if (phase === 'gate') crashGate = true; else crashCost = true; },
    revoke: () => { authorized = false; }, unresolved: () => { unresolvedGate = true; },
    holdCreate: () => { const entered = new Promise<void>(resolve => { createStarted = resolve; }); let release!: () => void; createWait = new Promise<void>(resolve => { release = resolve; }); return { entered, release }; },
    holdGate: () => {
      const entered = new Promise<void>(resolve => { gateStarted = resolve; });
      let release!: () => void; gateWait = new Promise<void>(resolve => { release = resolve; }); return { entered, release };
    },
  };
}

describe('SQL generation continuation with real session/task/budget factories', () => {
  let database: Awaited<ReturnType<typeof localPostgres>>;
  beforeAll(async () => { database = await localPostgres(); }, 60_000);
  afterAll(async () => { await database?.close(); }, 60_000);
  it('resumes an authoritative pending session after native PostgreSQL restart with exact replay', async () => {
    const h = harness(), input = request('restart');
    const initial = await h.factory(database.ports[0])(input); expect(initial).toMatchObject({ status: 'pending', reason: 'session_running' });
    expect(h.counts()).toEqual({ creates: 1, polls: 1, gates: 0, costs: 0 });
    const restarted = await database.restart(); database.ports = restarted.ports; database.observer = restarted.observer;
    h.complete();
    const result = await h.factory(database.ports[0], 'worker_restarted')(input);
    expect(result).toMatchObject({ status: 'complete', candidates: [{ provenance: { revision: 0, sessionId: 'fixture_session_1' } }] });
    expect(await h.factory(database.ports[1], 'worker_replay')(input)).toEqual(result);
    expect(h.counts()).toEqual({ creates: 1, polls: 2, gates: 1, costs: 1 });
    const rows = await database.observer.query("SELECT settled_micro_usd FROM agent_persistence.reservations WHERE settled_micro_usd IS NOT NULL");
    expect(rows.rows).toEqual([{ settled_micro_usd: '7' }]);
  });
  it('rejects changed immutable input with no new task identity or provider work', async () => {
    const h = harness(), input = request('changed'); h.complete();
    expect((await h.factory(database.ports[0])(input)).status).toBe('complete');
    const changed = structuredClone(input); changed.environment.name = 'changed environment';
    expect(await h.factory(database.ports[1])(changed)).toMatchObject({ status: 'blocked', reason: 'operation_identity_conflict' });
    expect(h.counts()).toMatchObject({ creates: 1, gates: 1, costs: 1 });
  });
  it('competing independent SQL workers cannot duplicate gate/provider/cost effects', async () => {
    const h = harness(), input = request('competing'); h.complete(); const gate = h.holdGate();
    const first = h.factory(database.ports[0], 'worker_a')(input);
    await gate.entered;
    const second = await h.factory(database.ports[1], 'worker_b')(input);
    expect(second.status).toBe('blocked');
    expect(h.counts()).toMatchObject({ creates: 1, gates: 1, costs: 1 });
    gate.release(); expect((await first).status).toBe('complete');
    expect((await h.factory(database.ports[1])(input)).status).toBe('complete');
    expect(h.counts()).toMatchObject({ creates: 1, gates: 1, costs: 1 });
    const pids = await Promise.all(database.ports.map(port => port.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')));
    expect(pids[0].rows[0].pid).not.toBe(pids[1].rows[0].pid);
  });
  it('fences competing workers while the initial provider create has no adopted session', async () => {
    const h = harness(), input = request('creating_race'); h.complete(); const create = h.holdCreate();
    const first = h.factory(database.ports[0], 'creator')(input); await create.entered;
    expect((await h.factory(database.ports[1], 'competitor')(input)).status).toBe('blocked');
    expect(h.counts()).toMatchObject({ creates: 1, gates: 0, costs: 0 });
    create.release(); expect((await first).status).toBe('complete');
    expect((await h.factory(database.ports[1])(input)).status).toBe('complete');
    expect(h.counts()).toMatchObject({ creates: 1, gates: 1, costs: 1 });
  });
  it('replays authoritative unresolved gate results without rerunning callbacks', async () => {
    const h = harness(), input = request('unresolved_gate'); h.complete(); h.unresolved();
    const first = await h.factory(database.ports[0])(input);
    expect(first).toMatchObject({ status: 'blocked', reason: 'gate_unresolved:fixture unknown gate' });
    expect(await h.factory(database.ports[1])(input)).toEqual(first);
    expect(h.counts()).toMatchObject({ creates: 1, gates: 1, costs: 1 });
  });
  it('checks authorization again before returning historical material', async () => {
    const h = harness(), input = request('authorization'); h.complete();
    expect((await h.factory(database.ports[0])(input)).status).toBe('complete'); h.revoke();
    expect(await h.factory(database.ports[1])(input)).toMatchObject({ status: 'blocked', candidates: [], costs: [] });
    expect(h.counts()).toMatchObject({ creates: 1, gates: 1, costs: 1 });
  });
  it('unknown create is permanently fenced rather than replayed as an authoritative session', async () => {
    const h = harness(), input = request('unknown_create'); h.unknown();
    const first = await h.factory(database.ports[0])(input);
    expect(['pending', 'blocked']).toContain(first.status);
    expect((await h.factory(database.ports[1])(input)).status).toBe('blocked');
    expect(h.counts()).toEqual({ creates: 1, polls: 0, gates: 0, costs: 0 });
  });
  it.each(['gate', 'cost'] as const)('preserves permanent %s callback ambiguity across factory restart', async phase => {
    const h = harness(), input = request(`crash_${phase}`); h.complete(); h.crash(phase);
    expect((await h.factory(database.ports[0])(input)).status).toBe('blocked');
    expect((await h.factory(database.ports[1])(input)).status).toBe('blocked');
    expect(h.counts()).toMatchObject({ creates: 1, costs: 1, gates: phase === 'gate' ? 1 : 0 });
  });
  it('replays rejection feedback and revisions without duplicating earlier effects', async () => {
    const h = harness(), input = request('revision'); h.complete(); h.reject();
    const first = await h.factory(database.ports[0])(input);
    expect(first).toMatchObject({ status: 'complete', candidates: [{ provenance: { revision: 1 } }] });
    expect(await h.factory(database.ports[1])(input)).toEqual(first);
    expect(h.counts()).toMatchObject({ creates: 2, gates: 2, costs: 2 });
  });
  it('rechecks historic durable bytes under rotated secrets before replaying effects', async () => {
    const h = harness(), input = request('rotation'); h.complete();
    expect((await h.factory(database.ports[0])(input)).status).toBe('complete');
    h.rotate(['fixture_session_1']);
    expect((await h.factory(database.ports[1])(input)).status).toBe('blocked');
    expect(h.counts()).toMatchObject({ creates: 1, gates: 1, costs: 1 });
  });
});

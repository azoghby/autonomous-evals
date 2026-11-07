import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { z } from 'zod';
import { fixtureJob, harness } from './__tests__/fakes';
import { AgentSessionService } from './session-service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresAgentTaskStore, PostgresBudgetLedger } from './postgres-ports';
import type { AgentSqlExecutor, AgentTransactionalSql } from './postgres-ports';
import type { AgentTaskRecord, BudgetReservationRequest } from '../evals/types';

const migration = readFileSync(new URL('./persistence-migrations/001-agent-persistence.sql', import.meta.url), 'utf8');
const timestamp = '2026-11-07T12:00:00.000Z';
function intent(taskKey = 'task-one'): AgentTaskRecord {
  return { taskKey, revision: 0, jobId: 'job-one', role: 'commercial', purpose: 'qualify', attempt: 1,
    agentId: 'agent-one', state: 'creating', idempotencyKey: `idem-${taskKey}`, reservationId: taskKey,
    budgetMicroUsd: 40, requestBody: { agent_id: 'agent-one', message: 'Synthetic task 🧪', budget_micro_usd: 40,
      output_schema: { type: 'object' }, structured_output_required: true, metadata: { taskKey } },
    sessionId: null, agentVersion: null, consumedMicroUsd: null, tokenUsage: null, result: null, error: null,
    replayCount: 0, leaseOwner: 'worker-one', leaseExpiresAt: '2026-11-07T12:02:00.000Z', createdAt: timestamp, updatedAt: timestamp };
}
function reservation(id: string, amount = 40, job = 'job-one', cap = 100): BudgetReservationRequest {
  return { reservationId: id, jobId: job, amountMicroUsd: amount, scopes: [
    { key: `job:${job}`, capMicroUsd: cap }, { key: 'agent:commercial:test', capMicroUsd: cap },
  ] };
}

describe('agent PostgreSQL adapters: PGlite SQL execution (single session, not real concurrency)', () => {
  let engine: PGlite;
  let db: AgentTransactionalSql;
  let store: PostgresAgentTaskStore;
  let ledger: PostgresBudgetLedger;
  beforeEach(async () => {
    engine = new PGlite();
    await engine.exec(migration);
    db = {
      query: <T>(sql: string, params?: unknown[]) => engine.query<T>(sql, params),
      transaction: fn => engine.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })),
    };
    store = new PostgresAgentTaskStore(db); ledger = new PostgresBudgetLedger(db);
  });
  afterEach(async () => { await engine.close(); });

  it('runs the session service on SQL ports and replays from fresh adapters without provider calls', async () => {
    const h = harness(() => ({ structuredOutput: { answer: 'ok' } }), { store, ledger });
    const spec = { job: fixtureJob(), role: 'commercial' as const, purpose: 'sql_integration', message: 'Return JSON.',
      output: { name: 'sql.v1', schema: z.object({ answer: z.string() }) }, budgetMicroUsd: 100_000 };
    const first = await h.service.run(spec);
    expect(first.status).toBe('completed');
    expect(h.naive.createCalls).toHaveLength(1);
    const calls = h.naive.getCalls;
    const restarted = new AgentSessionService({ ...h.deps, workerId: 'restarted', store: new PostgresAgentTaskStore(db), ledger: new PostgresBudgetLedger(db) });
    expect(await restarted.run(spec)).toEqual(first);
    expect(h.naive.createCalls).toHaveLength(1);
    expect(h.naive.getCalls).toBe(calls);
    const saved = await store.get(first.taskKey);
    expect(saved).toMatchObject({ state: 'completed', consumedMicroUsd: 12_345 });
    expect(await ledger.settle(saved!.reservationId, 99_999)).toEqual({ settledMicroUsd: 12_345, replayed: true });
  });

  it('persists exact JSON, returns detached records, and resumes through a fresh adapter', async () => {
    expect(await store.get('missing')).toBeNull();
    const record = intent();
    expect(await store.insertIfAbsent(record)).toEqual({ inserted: true, record });
    record.requestBody.message = 'mutated locally';
    const read = await new PostgresAgentTaskStore(db).get(record.taskKey);
    expect(read?.requestBody.message).toBe('Synthetic task 🧪');
    read!.requestBody.message = 'also mutated';
    expect((await store.get(record.taskKey))?.requestBody.message).toBe('Synthetic task 🧪');
  });

  it('insert replay preserves first timestamp and current state; changed identity fails', async () => {
    const record = intent(); await store.insertIfAbsent(record);
    await store.compareAndSet(record.taskKey, 0, { state: 'created', sessionId: 'session-one' });
    const replay = await store.insertIfAbsent({ ...record, createdAt: '2026-11-07T12:00:01.000Z' });
    expect(replay.inserted).toBe(false); expect(replay.record.revision).toBe(1);
    expect(replay.record.createdAt).toBe(timestamp); expect(replay.record.sessionId).toBe('session-one');
    await expect(store.insertIfAbsent({ ...record, jobId: 'other-job' })).rejects.toThrow('identity_conflict');
    await expect(store.insertIfAbsent({ ...record, requestBody: { ...record.requestBody, message: 'different request' } })).rejects.toThrow('identity_conflict');
  });

  it('CAS advances once, rejects stale/missing writes, and forbids identity patches', async () => {
    const record = intent(); await store.insertIfAbsent(record);
    expect(await store.compareAndSet(record.taskKey, 0, { state: 'created', sessionId: 'session-one' })).toMatchObject({ revision: 1, state: 'created' });
    expect(await store.compareAndSet(record.taskKey, 0, { state: 'failed' })).toBeNull();
    expect(await store.compareAndSet('missing', 0, { state: 'failed' })).toBeNull();
    for (const patch of [{ jobId: 'other' }, { budgetMicroUsd: 99 }, { requestBody: record.requestBody }]) {
      await expect(store.compareAndSet(record.taskKey, 1, patch)).rejects.toThrow('invalid_input');
    }
    expect((await store.get(record.taskKey))?.revision).toBe(1);
  });

  it('parameterizes SQL-looking identifiers and rejects PostgreSQL-unsafe strings without echoing values', async () => {
    const record = intent("x'; DROP SCHEMA agent_persistence CASCADE; --");
    await store.insertIfAbsent(record); expect(await store.get(record.taskKey)).toEqual(record);
    for (const value of ['bad\0credential', '\ud800']) {
      await expect(store.get(value)).rejects.toThrow(/^agent_persistence_invalid_input$/);
      await expect(store.insertIfAbsent({ ...intent(), requestBody: { ...intent().requestBody, message: value } })).rejects.toThrow(/^agent_persistence_invalid_input$/);
    }
  });

  it('rejects unsafe money, counters, states, timestamps and unsupported JSON before writes', async () => {
    for (const amount of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      await expect(ledger.reserve(reservation('invalid', amount))).rejects.toThrow('invalid_input');
    }
    for (const patch of [{ budgetMicroUsd: Number.MAX_SAFE_INTEGER + 1 }, { revision: -1 }, { replayCount: 0.5 }, { createdAt: 'not-a-date' }, { consumedMicroUsd: -1 }]) {
      await expect(store.insertIfAbsent({ ...intent(), ...patch })).rejects.toThrow('invalid_input');
    }
    expect((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM agent_persistence.tasks')).rows[0].n).toBe('0');
  });

  it('normalizes scope order, replays accepted reservations, and rejects identity or cap changes atomically', async () => {
    const req = reservation('reserve-one');
    expect(await ledger.reserve(req)).toEqual({ ok: true, reservationId: req.reservationId, replayed: false });
    expect(await ledger.reserve({ ...req, scopes: [...req.scopes].reverse() })).toEqual({ ok: true, reservationId: req.reservationId, replayed: true });
    for (const changed of [{ ...req, amountMicroUsd: 41 }, { ...req, jobId: 'other', scopes: reservation('x', 40, 'other').scopes }, { ...req, scopes: req.scopes.map(s => ({ ...s, capMicroUsd: 101 })) }]) {
      await expect(ledger.reserve(changed)).rejects.toThrow('identity_conflict');
    }
    await expect(ledger.reserve(reservation('cap-change', 40, 'job-new', 101))).rejects.toThrow('scope_cap_conflict');
    expect((await db.query('SELECT id FROM agent_persistence.reservations WHERE id=$1', ['cap-change'])).rows).toHaveLength(0);
    expect((await db.query('SELECT key FROM agent_persistence.scopes WHERE key=$1', ['job:job-new'])).rows).toHaveLength(0);
  });

  it('locks scopes in sorted order, enforces job and role budgets, and records a stable refusal', async () => {
    const locks: string[] = [];
    const observed: AgentTransactionalSql = { query: db.query, transaction: fn => db.transaction(tx => fn({
      async query<T>(sql: string, params?: unknown[]) { if (sql.includes('FROM agent_persistence.scopes') && sql.includes('FOR UPDATE')) locks.push(String(params?.[0])); return tx.query<T>(sql, params); },
    })) };
    await new PostgresBudgetLedger(observed).reserve(reservation('a', 80));
    expect(locks).toEqual(['agent:commercial:test', 'job:job-one']);
    const denied = await ledger.reserve(reservation('b', 30, 'job-two'));
    expect(denied).toEqual({ ok: false, reservationId: 'b', exhaustedScope: 'agent:commercial:test', capMicroUsd: 100, availableMicroUsd: 20 });
    await ledger.settle('a', 0);
    expect(await ledger.reserve(reservation('b', 30, 'job-two'))).toEqual(denied);
    expect((await ledger.reserve(reservation('c', 100))).ok).toBe(true);
    const jobOnlyCap = reservation('job-denied', 1); jobOnlyCap.scopes[1] = { key: 'agent:company_operator:test', capMicroUsd: 100 };
    expect(await ledger.reserve(jobOnlyCap)).toMatchObject({ ok: false, exhaustedScope: 'job:job-one', availableMicroUsd: 0 });
    await expect(ledger.settle('b', 0)).rejects.toThrow('unknown_reservation');
  });

  it('settles measured overage without capping, releases unused funds, and keeps the first settlement', async () => {
    await ledger.reserve(reservation('a', 40));
    expect(await ledger.settle('a', 130)).toEqual({ settledMicroUsd: 130, replayed: false });
    expect(await new PostgresBudgetLedger(db).settle('a', 0)).toEqual({ settledMicroUsd: 130, replayed: true });
    expect(await ledger.reserve(reservation('b', 1))).toMatchObject({ ok: false, availableMicroUsd: 0 });
    expect((await db.query<{ n: string }>('SELECT settled_micro_usd::text AS n FROM agent_persistence.reservations WHERE id=$1', ['a'])).rows[0].n).toBe('130');
    await expect(ledger.settle('missing', 1)).rejects.toThrow('unknown_reservation');
    await expect(ledger.settle('a', Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow('invalid_input');
  });

  it('uses exact SQL numeric aggregation even when combined overages exceed safe JavaScript integer range', async () => {
    const req = reservation('large-a', 1, 'job-one', Number.MAX_SAFE_INTEGER);
    await ledger.reserve(req); await ledger.reserve({ ...req, reservationId: 'large-b' });
    await ledger.settle('large-a', Number.MAX_SAFE_INTEGER); await ledger.settle('large-b', Number.MAX_SAFE_INTEGER);
    expect(await ledger.reserve({ ...req, reservationId: 'large-c' })).toMatchObject({ ok: false, availableMicroUsd: 0 });
  });

  it('rolls back reservations and settlements when the transaction callback fails after SQL writes', async () => {
    let failAfter = 'SET first_result';
    const faulty: AgentTransactionalSql = { query: db.query, transaction: fn => db.transaction(tx => fn({
      async query<T>(sql: string, params?: unknown[]) { const result = await tx.query<T>(sql, params); if (sql.includes(failAfter)) throw new Error('injected_after_write'); return result; },
    })) };
    await expect(new PostgresBudgetLedger(faulty).reserve(reservation('rollback'))).rejects.toThrow('injected_after_write');
    expect((await db.query('SELECT id FROM agent_persistence.reservations')).rows).toHaveLength(0);
    expect((await db.query('SELECT key FROM agent_persistence.scopes')).rows).toHaveLength(0);
    await ledger.reserve(reservation('a'));
    failAfter = 'SET settled_micro_usd';
    await expect(new PostgresBudgetLedger(faulty).settle('a', 90)).rejects.toThrow('injected_after_write');
    expect(await ledger.settle('a', 10)).toEqual({ settledMicroUsd: 10, replayed: false });
    expect((await ledger.reserve(reservation('b', 90))).ok).toBe(true);
  });

  it('rejects duplicate or missing job/role scopes rather than bypassing aggregate caps', async () => {
    const req = reservation('a');
    for (const scopes of [[], [req.scopes[0]], [req.scopes[1]], [...req.scopes, req.scopes[0]]]) {
      await expect(ledger.reserve({ ...req, scopes })).rejects.toThrow('invalid_input');
    }
  });
});

// Registered only for an explicitly supplied local disposable server. PGlite tests above
// execute real PostgreSQL SQL, but provide no evidence of independent-session concurrency.
const liveUrl = process.env.AGENT_PERSISTENCE_TEST_DATABASE_URL;
if (liveUrl) describe('agent persistence: real PostgreSQL independent-session races', () => {
  let pool: Pool;
  let db: AgentTransactionalSql;
  let ledger: PostgresBudgetLedger;
  let store: PostgresAgentTaskStore;
  let created = false;
  const pids = new Set<number>();
  beforeAll(async () => {
    const url = new URL(liveUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Persistence tests require an explicit local disposable PostgreSQL server');
    pool = new Pool({ connectionString: liveUrl, max: 24, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    await pool.query(migration); created = true;
    db = {
      async query<T>(sql: string, params?: unknown[]) { const result = await pool.query(sql, params); return { rows: result.rows as T[] }; },
      async transaction<T>(fn: (tx: AgentSqlExecutor) => Promise<T>) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          pids.add((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
          const value = await fn({ async query<R>(sql: string, params?: unknown[]) { const result = await client.query(sql, params); return { rows: result.rows as R[] }; } });
          await client.query('COMMIT'); return value;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
    };
    ledger = new PostgresBudgetLedger(db); store = new PostgresAgentTaskStore(db);
  });
  afterAll(async () => { if (created) await pool.query('DROP SCHEMA agent_persistence CASCADE'); if (pool) await pool.end(); });
  beforeEach(async () => { await pool.query('TRUNCATE agent_persistence.tasks, agent_persistence.reservations, agent_persistence.scopes'); });

  it('20 sessions cannot oversubscribe a shared role scope across different jobs', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => ledger.reserve(reservation(`race-${i}`, 10, `job-${i}`))));
    expect(results.filter(r => r.ok)).toHaveLength(10);
    expect(pids.size).toBeGreaterThan(1);
    expect((await pool.query("SELECT sum(amount_micro_usd)::text AS n FROM agent_persistence.reservations WHERE first_result->>'ok'='true'")).rows[0].n).toBe('100');
  });

  it('20 sessions cannot oversubscribe a shared job scope across distinct role periods', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => {
      const req = reservation(`job-race-${i}`, 10);
      req.scopes[1] = { key: `agent:commercial:period-${i}`, capMicroUsd: 100 };
      return ledger.reserve(req);
    }));
    expect(results.filter(r => r.ok)).toHaveLength(10);
  });

  it('same-ID insert/reserve/CAS/settle races have one winner and first settlement survives', async () => {
    const inserts = await Promise.all(Array.from({ length: 12 }, () => store.insertIfAbsent(intent())));
    expect(inserts.filter(r => r.inserted)).toHaveLength(1);
    const updates = await Promise.all(Array.from({ length: 12 }, (_, i) => store.compareAndSet('task-one', 0, { leaseOwner: `worker-${i}` })));
    expect(updates.filter(Boolean)).toHaveLength(1);
    const reserves = await Promise.all(Array.from({ length: 12 }, () => ledger.reserve(reservation('same'))));
    expect(reserves.filter(r => r.ok && !r.replayed)).toHaveLength(1);
    const settles = await Promise.all(Array.from({ length: 12 }, (_, i) => ledger.settle('same', 101 + i)));
    expect(settles.filter(r => !r.replayed)).toHaveLength(1);
    expect(new Set(settles.map(r => r.settledMicroUsd)).size).toBe(1);
    expect(settles[0].settledMicroUsd).toBeGreaterThan(100);
  });

  it('opposite scope ordering completes without deadlock and settlement races preserve cap accounting', async () => {
    await ledger.reserve(reservation('original', 80));
    const reversed = reservation('new', 30); reversed.scopes.reverse();
    const [settled, reserved] = await Promise.all([ledger.settle('original', 0), ledger.reserve(reversed)]);
    expect(settled.settledMicroUsd).toBe(0);
    expect(reserved.ok || (!reserved.ok && reserved.availableMicroUsd === 20)).toBe(true);
    const rows = (await pool.query("SELECT COALESCE(sum(COALESCE(settled_micro_usd,amount_micro_usd)),0)::text AS n FROM agent_persistence.reservations WHERE first_result->>'ok'='true'")).rows;
    expect(Number(rows[0].n)).toBeLessThanOrEqual(100);
  });
});

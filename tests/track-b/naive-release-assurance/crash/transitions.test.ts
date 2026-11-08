import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { createPostgresAgentRuntime } from '../../../../packages/core/src/agents/runtime';
import type { AgentSqlExecutor, AgentTransactionalSql } from '../../../../packages/core/src/agents/postgres-ports';
import { FakeNaive, ManualClock, directory, fixtureJob } from '../../../../packages/core/src/agents/__tests__/fakes';
import { NaiveCallError, type AgentTaskRecord, type CostEntry } from '../../../../packages/core/src/evals/types';

const migration = readFileSync(new URL('../../../../packages/core/src/agents/persistence-migrations/001-agent-persistence.sql', import.meta.url), 'utf8');
const spec = () => ({ job: fixtureJob(), role: 'commercial' as const, purpose: 'crash',
  message: 'Return an answer.', budgetMicroUsd: 100_000,
  output: { name: 'crash.v1', schema: z.object({ answer: z.string() }) } });
type Boundary = 'adoption' | 'settlement' | 'terminal';
type Fault = { boundary: Boundary; timing: 'rollback' | 'lost_ack' };
const crash = new Error('injected_crash');

async function harness() {
  const sql = new PGlite();
  await sql.exec(migration);
  await sql.exec('CREATE TABLE crash_costs (key text PRIMARY KEY, entry jsonb NOT NULL)');
  const naive = new FakeNaive(() => ({ structuredOutput: { answer: 'ok' } }));
  const clock = new ManualClock();
  let armed: Fault | undefined;
  let fired = 0;
  let delivery: 'before_commit' | 'lost_ack' | undefined;
  let deliveryCalls = 0;
  let lists = 0;
  let settlementHold: { committed: () => void; gate: Promise<void> } | undefined;
  const list = naive.listAgentSessions.bind(naive);
  naive.listAgentSessions = async (...args) => { lists++; return list(...args); };
  const db: AgentTransactionalSql = {
    query: <T>(s: string, p?: unknown[]) => sql.query<T>(s, p),
    async transaction<T>(fn: (tx: AgentSqlExecutor) => Promise<T>): Promise<T> {
      let matched: Fault | undefined;
      let held: typeof settlementHold;
      const result = await sql.transaction(async tx => {
        const out = await fn({ async query<U>(s: string, p?: unknown[]) {
          const result = await tx.query<U>(s, p);
          let boundary: Boundary | undefined;
          if (s.startsWith('UPDATE agent_persistence.tasks SET record')) {
            const state = JSON.parse(p![2] as string).state;
            if (state === 'created') boundary = 'adoption';
            if (state === 'completed') boundary = 'terminal';
          }
          if (s.startsWith('UPDATE agent_persistence.reservations SET settled_micro_usd')) {
            boundary = 'settlement';
            held = settlementHold; settlementHold = undefined;
          }
          if (armed && boundary === armed.boundary) {
            matched = armed; armed = undefined; fired++;
            if (matched.timing === 'rollback') throw crash;
          }
          return result;
        } });
        return out;
      });
      if (held) { held.committed(); await held.gate; }
      // Throw only after PGlite has committed, simulating a lost COMMIT acknowledgement.
      if (matched?.timing === 'lost_ack') throw crash;
      return result;
    },
  };
  const runtime = () => createPostgresAgentRuntime({ db, naive, directory, clock,
    workerId: `restart-${clock.t}`, budgetPeriodId: 'crash', idempotencyNamespace: 'crash',
    maxWaitMs: 0, leaseMs: 1000,
    costs: { async record(key, entry) {
      deliveryCalls++;
      const mode = delivery; delivery = undefined;
      if (mode === 'before_commit') throw crash;
      await sql.query('INSERT INTO crash_costs VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING', [key, JSON.stringify(entry)]);
      const row = (await sql.query<{ entry: CostEntry }>('SELECT entry FROM crash_costs WHERE key = $1', [key])).rows[0];
      assert.deepEqual(row.entry, entry, 'sink must reject changed payload under the same key');
      if (mode === 'lost_ack') throw crash;
    } },
  });
  async function state() {
    const tasks = await sql.query<{ record: AgentTaskRecord; revision: number }>('SELECT record, revision FROM agent_persistence.tasks');
    const reservations = await sql.query<{ settled: number | null; amount: number }>('SELECT settled_micro_usd::int AS settled, amount_micro_usd::int AS amount FROM agent_persistence.reservations');
    const costs = await sql.query<{ key: string; entry: CostEntry }>('SELECT * FROM crash_costs');
    return { tasks: tasks.rows, reservations: reservations.rows, costs: costs.rows };
  }
  return { sql, naive, clock, runtime, state, arm: (f: Fault) => { armed = f; },
    holdSettlement() {
      let committed!: () => void; let release!: () => void;
      const settled = new Promise<void>(resolve => { committed = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      settlementHold = { committed, gate };
      return { settled, release };
    },
    failDelivery: (mode: typeof delivery) => { delivery = mode; },
    counts: () => ({ fired, deliveryCalls, lists }) };
}

for (const boundary of ['adoption', 'settlement', 'terminal'] as const) {
  for (const timing of ['rollback', 'lost_ack'] as const) {
    test(`ACCEPTANCE: ${boundary} ${timing} resumes one provider session and one measured charge`, async t => {
      const h = await harness(); t.after(() => h.sql.close());
      h.arm({ boundary, timing });
      await assert.rejects(h.runtime().run(spec()), /injected_crash/);
      assert.equal(h.counts().fired, 1, 'fault must actually hit the requested SQL transaction');
      const interrupted = await h.state();
      assert.equal(interrupted.tasks.length, 1);
      assert.equal(interrupted.reservations.length, 1);
      assert.equal(interrupted.costs.length, 0);
      assert.equal(h.naive.sessions.size, 1);
      const rec = interrupted.tasks[0].record;
      assert.equal(rec.state, boundary === 'adoption' && timing === 'rollback' ? 'creating'
        : boundary === 'terminal' && timing === 'lost_ack' ? 'completed' : 'created');
      assert.equal(interrupted.reservations[0].settled,
        boundary === 'adoption' || (boundary === 'settlement' && timing === 'rollback') ? null : 12_345);
      if (boundary === 'adoption' && timing === 'rollback') {
        assert.equal(rec.sessionId, null);
        assert.equal((await h.runtime().run(spec())).status, 'pending', 'unexpired create lease blocks recovery');
        assert.equal(h.counts().lists, 0);
      }
      const polls = h.naive.getCalls;
      h.clock.advance(1001);
      const completed = await h.runtime().run(spec());
      assert.equal(completed.status, 'completed');
      if (completed.status !== 'completed') throw new Error('unexpected outcome');
      assert.deepEqual(completed.output, { answer: 'ok' });
      assert.equal(completed.cost.microUsd, 12_345);
      assert.equal(completed.cost.measured, true);
      assert.equal(h.naive.getCalls - polls, boundary === 'terminal' && timing === 'lost_ack' ? 0 : 1);
      assert.equal(h.counts().lists, boundary === 'adoption' && timing === 'rollback' ? 1 : 0);
      const after = await h.state();
      assert.equal(after.tasks[0].record.sessionId, completed.session.sessionId);
      assert.equal(after.reservations[0].settled, 12_345);
      assert.deepEqual(after.costs, [{ key: `naive:${completed.session.sessionId}`, entry: completed.cost }]);
      // Replay of a terminal row redelivers the identical cost and does no provider I/O.
      assert.deepEqual(await h.runtime().run(spec()), completed);
      assert.equal((await h.state()).costs.length, 1);
      assert.equal(h.naive.createCalls.length, 1);
      assert.equal(h.naive.sessions.size, 1);
    });
  }
}

for (const mode of ['before_commit', 'lost_ack'] as const) {
  test(`ACCEPTANCE: cost delivery ${mode} retries durable outcome with identical payload`, async t => {
    const h = await harness(); t.after(() => h.sql.close());
    h.failDelivery(mode);
    await assert.rejects(h.runtime().run(spec()), /injected_crash/);
    const interrupted = await h.state();
    assert.equal(interrupted.tasks[0].record.state, 'completed');
    assert.equal(interrupted.reservations[0].settled, 12_345);
    assert.equal(interrupted.costs.length, mode === 'lost_ack' ? 1 : 0);
    const polls = h.naive.getCalls;
    const first = await h.runtime().run(spec());
    assert.equal(first.status, 'completed');
    assert.deepEqual(await h.runtime().run(spec()), first);
    assert.equal(h.naive.getCalls, polls);
    assert.equal(h.naive.createCalls.length, 1);
    assert.equal(h.counts().deliveryCalls, 3);
    assert.equal((await h.state()).costs.length, 1);
  });
}

test('ACCEPTANCE: provider create acknowledgement loss recovers by lookup before any replay', async t => {
  const h = await harness(); t.after(() => h.sql.close());
  h.naive.createFailures.set(0, { error: new NaiveCallError('ambiguous', 'lost create ack'), createdAnyway: true });
  assert.equal((await h.runtime().run(spec())).status, 'pending');
  const interrupted = await h.state();
  assert.equal(interrupted.tasks[0].record.state, 'ambiguous');
  assert.equal(interrupted.tasks[0].record.sessionId, null);
  assert.equal(interrupted.reservations[0].settled, null);
  assert.equal(interrupted.costs.length, 0);
  assert.equal((await h.runtime().run(spec())).status, 'completed');
  assert.equal(h.counts().lists, 1);
  assert.equal(h.naive.createCalls.length, 1);
  assert.equal((await h.state()).costs[0].entry.microUsd, 12_345);
});

test('ACCEPTANCE: two finalizers race the actual SQL CAS and deliver one idempotent charge', { timeout: 60_000 }, async t => {
  const h = await harness(); t.after(() => h.sql.close());
  h.naive.setScript(() => ({ pollsUntilDone: 1, structuredOutput: { answer: 'ok' } }));
  assert.equal((await h.runtime().run(spec())).status, 'pending');
  const revision = Number((await h.state()).tasks[0].revision);
  const get = h.naive.getSession.bind(h.naive);
  let arrivals = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.naive.getSession = async id => {
    const snapshot = await get(id);
    if (++arrivals === 2) release();
    await gate; // Both workers read the same created task revision before either settles.
    return snapshot;
  };
  const outcomes = await Promise.all([h.runtime().run(spec()), h.runtime().run(spec())]);
  assert.equal(arrivals, 2);
  assert.equal(outcomes[0].status, 'completed');
  assert.deepEqual(outcomes[0], outcomes[1]);
  const after = await h.state();
  assert.equal(Number(after.tasks[0].revision), revision + 1, 'only one terminal CAS may win');
  assert.equal(after.reservations.length, 1);
  assert.equal(after.reservations[0].settled, 12_345);
  assert.equal(after.costs.length, 1);
  assert.equal(h.counts().deliveryCalls, 2);
  assert.equal(h.naive.createCalls.length, 1);
});

for (const fault of [
  { boundary: 'terminal', timing: 'rollback' },
  { boundary: 'settlement', timing: 'lost_ack' },
] as const) {
  test(`REGRESSION D1: revised usage after ${fault.boundary} ${fault.timing} preserves first settlement and quarantines output`, async t => {
    const h = await harness(); t.after(() => h.sql.close());
    h.arm(fault);
    await assert.rejects(h.runtime().run(spec()), /injected_crash/);
    assert.equal((await h.state()).reservations[0].settled, 12_345);
    const session = [...h.naive.sessions.values()][0];
    session.consumedMicroUsd = 23_456;
    const result = await h.runtime().run(spec());
    assert.equal(result.status, 'needs_operator');
    if (result.status !== 'needs_operator') throw new Error('unexpected outcome');
    assert.equal(result.code, 'settlement_usage_conflict');
    assert.equal(result.cost?.microUsd, 12_345);
    assert.equal('output' in result, false);
    const after = await h.state();
    assert.equal(after.reservations[0].settled, 12_345);
    assert.equal(after.tasks[0].record.consumedMicroUsd, 12_345);
    assert.equal(after.costs[0].entry.microUsd, 12_345);
    assert.equal(h.naive.createCalls.length, 1);
    const polls = h.naive.getCalls;
    assert.deepEqual(await h.runtime().run(spec()), result);
    assert.equal(h.naive.getCalls, polls);
    assert.equal((await h.state()).costs.length, 1);
  });
}

test('REGRESSION D1: concurrent revised-usage finalizer cannot overwrite first settlement or return stale valid output', async t => {
  const h = await harness(); t.after(() => h.sql.close());
  h.naive.setScript(() => ({ pollsUntilDone: 1, structuredOutput: { answer: 'ok' } }));
  assert.equal((await h.runtime().run(spec())).status, 'pending');
  const hold = h.holdSettlement();
  const first = h.runtime().run(spec());
  await hold.settled;
  [...h.naive.sessions.values()][0].consumedMicroUsd = 23_456;
  let second: Awaited<ReturnType<ReturnType<typeof h.runtime>['run']>>;
  try { second = await h.runtime().run(spec()); } finally { hold.release(); }
  const outcomes = [await first, second];
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(outcomes[0].status, 'needs_operator');
  if (outcomes[0].status !== 'needs_operator') throw new Error('unexpected outcome');
  assert.equal(outcomes[0].code, 'settlement_usage_conflict');
  assert.equal(outcomes[0].cost?.microUsd, 12_345);
  const after = await h.state();
  assert.equal(after.reservations[0].settled, 12_345);
  assert.equal(after.tasks[0].record.consumedMicroUsd, 12_345);
  assert.equal(after.costs.length, 1);
  assert.equal(after.costs[0].entry.microUsd, 12_345);
  assert.equal(h.naive.createCalls.length, 1);
});

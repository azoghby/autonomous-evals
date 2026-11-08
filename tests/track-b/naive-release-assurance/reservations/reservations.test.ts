import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PostgresBudgetLedger } from '../../../../packages/core/src/agents/postgres-ports';
import { createPostgresAgentRuntime } from '../../../../packages/core/src/agents/runtime';
import { FakeNaive, ManualClock, directory, fixtureJob } from '../../../../packages/core/src/agents/__tests__/fakes';
import { z } from 'zod';
import { localPostgres } from './local-postgres';

type Request = Parameters<PostgresBudgetLedger['reserve']>[0];
const roleKey = 'agent:commercial:assurance';
const request = (id: string, job = 'job-one', role = roleKey, amount = 60, cap = 100): Request => ({
  reservationId: id, jobId: job, amountMicroUsd: amount,
  scopes: [{ key: `job:${job}`, capMicroUsd: cap }, { key: role, capMicroUsd: cap }],
});

describe('native PostgreSQL reservations (production ledger/runtime; fake provider only)', { concurrency: false }, () => {
  let sql: Awaited<ReturnType<typeof localPostgres>>;
  let ledgers: PostgresBudgetLedger[];
  before(async () => {
    sql = await localPostgres();
    ledgers = sql.ports.map(db => new PostgresBudgetLedger(db));
    const pids = await Promise.all(sql.sessions.map(c => c.query('SELECT pg_backend_pid() AS pid')));
    assert.equal(new Set(pids.map(r => r.rows[0].pid)).size, 4);
    assert.equal((await sql.observer.query('SHOW listen_addresses')).rows[0].listen_addresses, '');
    console.log(`SQL proof: ${(await sql.observer.query('SELECT version() AS version')).rows[0].version}; four independent sessions, Unix sockets, READ COMMITTED`);
  });
  after(async () => { await sql?.close(); });
  beforeEach(async () => {
    await sql.observer.query('TRUNCATE agent_persistence.tasks, agent_persistence.reservations, agent_persistence.scopes');
  });
  const row = async (id: string) => (await sql.observer.query('SELECT * FROM agent_persistence.reservations WHERE id=$1', [id])).rows[0];
  const scopes = async () => (await sql.observer.query('SELECT * FROM agent_persistence.scopes ORDER BY key')).rows;

  // Observe *both* real backends blocked on a held scope before allowing progress.
  // Promise.all alone would not establish overlapping transactions/row-lock behavior.
  async function raceOnScope<T>(key: string, calls: (() => Promise<T>)[]) {
    await sql.observer.query('BEGIN');
    let pending: Promise<PromiseSettledResult<T>[]> | undefined;
    try {
      await sql.observer.query('SELECT key FROM agent_persistence.scopes WHERE key=$1 FOR UPDATE', [key]);
      pending = Promise.allSettled(calls.map(call => call()));
      const deadline = Date.now() + 4000;
      let blocked = 0;
      while (Date.now() < deadline) {
        blocked = Number((await sql.observer.query(`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND pid <> pg_backend_pid() AND wait_event_type='Lock'`)).rows[0].n);
        if (blocked >= calls.length) break;
        await delay(10);
      }
      assert.equal(blocked, calls.length, 'each independent contender must reach a PostgreSQL lock wait');
    } finally { await sql.observer.query('ROLLBACK'); }
    const outcomes = await pending!;
    return outcomes.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
  }

  for (const kind of ['role', 'job', 'role+job'] as const) {
    it(`ACCEPTANCE: simultaneous ${kind} scope reservations admit exactly one; loser spends nothing`, async () => {
      const secondRole = kind === 'job' ? 'agent:evaluation_engineer:assurance' : roleKey;
      const secondJob = kind === 'role' ? 'job-two' : 'job-one';
      const a = request('a');
      const b = request('b', secondJob, secondRole);
      const held = kind === 'job' ? 'job:job-one' : roleKey;
      await sql.observer.query('INSERT INTO agent_persistence.scopes VALUES ($1,100)', [held]);
      b.scopes.reverse(); // Caller ordering must not cause inconsistent lock order.
      const results = await raceOnScope(held, [() => ledgers[0].reserve(a), () => ledgers[1].reserve(b)]);
      assert.equal(results.filter(r => r.ok).length, 1);
      const loser = results.find(r => !r.ok)!;
      assert.equal(loser.ok, false);
      if (!loser.ok) { assert.equal(loser.availableMicroUsd, 40); assert.equal(loser.exhaustedScope, held); }
      const committed = (await sql.observer.query(`SELECT sum(amount_micro_usd)::int AS amount FROM agent_persistence.reservations WHERE first_result->>'ok'='true'`)).rows[0].amount;
      assert.equal(committed, 60);
      assert.equal((await sql.observer.query('SELECT count(*)::int AS n FROM agent_persistence.reservations')).rows[0].n, 2);
    });
  }

  it('ACCEPTANCE: simultaneous same-ID requests create one commitment and replay across sessions', async () => {
    await sql.observer.query('INSERT INTO agent_persistence.scopes VALUES ($1,100)', [roleKey]);
    // The duplicate blocks on reservation identity, while its owner blocks on the scope.
    const results = await raceOnScope(roleKey, [() => ledgers[0].reserve(request('same')), () => ledgers[1].reserve(request('same'))]);
    assert.deepEqual(results.map(r => r.ok && r.replayed).sort(), [false, true]);
    assert.equal((await sql.observer.query('SELECT count(*)::int AS n FROM agent_persistence.reservations')).rows[0].n, 1);
    const reversed = request('same'); reversed.scopes.reverse();
    assert.deepEqual(await ledgers[2].reserve(reversed), { ok: true, reservationId: 'same', replayed: true });
  });

  it('ACCEPTANCE: role and job caps are independently enforced, immutable after settlement, and conflicts roll back', async () => {
    assert.equal((await ledgers[0].reserve(request('seed'))).ok, true);
    await ledgers[0].settle('seed', 10);
    for (const index of [0, 1]) {
      for (const changed of [99, 101]) {
        const input = request(`conflict-${index}-${changed}`); input.scopes[index].capMicroUsd = changed;
        await assert.rejects(ledgers[1].reserve(input), /agent_persistence_scope_cap_conflict/);
        assert.equal(await row(input.reservationId), undefined);
      }
    }
    assert.deepEqual((await scopes()).map(s => Number(s.cap_micro_usd)), [100, 100]);
    const byRole = await ledgers[2].reserve(request('role-denied', 'different', roleKey, 91));
    assert.equal(byRole.ok, false);
    if (!byRole.ok) { assert.equal(byRole.exhaustedScope, roleKey); assert.equal(byRole.availableMicroUsd, 90); }
    const byJob = await ledgers[3].reserve(request('job-denied', 'job-one', 'agent:company_operator:assurance', 91));
    assert.equal(byJob.ok, false);
    if (!byJob.ok) { assert.equal(byJob.exhaustedScope, 'job:job-one'); assert.equal(byJob.availableMicroUsd, 90); }
    // A previously unseen role sorts before the conflicting job; its insert must roll back too.
    const fresh = request('rollback', 'job-one', 'agent:quality_investigator:assurance'); fresh.scopes[0].capMicroUsd = 200;
    await assert.rejects(ledgers[0].reserve(fresh), /scope_cap_conflict/);
    assert.equal((await scopes()).some(s => s.key === fresh.scopes[1].key), false);
  });

  it('ACCEPTANCE: identity cannot change job, amount or scope under an accepted reservation ID', async () => {
    await ledgers[0].reserve(request('identity'));
    for (const changed of [request('identity', 'other'), request('identity', 'job-one', roleKey, 61), request('identity', 'job-one', 'agent:commercial:other')]) {
      await assert.rejects(ledgers[1].reserve(changed), /reservation_identity_conflict/);
    }
    assert.equal(Number((await row('identity')).amount_micro_usd), 60);
    assert.equal((await scopes()).length, 2);
  });

  it('ACCEPTANCE: refusal remains immutable after capacity is released; fresh identity can use the release', async () => {
    await ledgers[0].reserve(request('accepted'));
    const refused = await ledgers[1].reserve(request('refused'));
    assert.equal(refused.ok, false);
    await ledgers[2].settle('accepted', 0);
    assert.deepEqual(await ledgers[3].reserve(request('refused')), refused);
    await assert.rejects(ledgers[0].settle('refused', 0), /unknown_reservation/);
    assert.equal((await ledgers[1].reserve(request('fresh', 'job-one', roleKey, 100))).ok, true);
  });

  it('ACCEPTANCE: concurrent first settlement is immutable; full overage blocks both scopes without clamping', async () => {
    await ledgers[0].reserve(request('spent'));
    const settlements = await raceOnScope(roleKey, [() => ledgers[0].settle('spent', 150), () => ledgers[1].settle('spent', 200)]);
    const actual = settlements[0].settledMicroUsd;
    assert.ok(actual === 150 || actual === 200);
    assert.equal(settlements[1].settledMicroUsd, actual);
    assert.deepEqual(settlements.map(r => r.replayed).sort(), [false, true]);
    assert.equal(Number((await row('spent')).settled_micro_usd), actual);
    for (const input of [request('role-blocked', 'other-job', roleKey, 1), request('job-blocked', 'job-one', 'agent:company_operator:assurance', 1)]) {
      const denied = await ledgers[2].reserve(input);
      assert.equal(denied.ok, false);
      if (!denied.ok) assert.equal(denied.availableMicroUsd, 0);
    }
    assert.deepEqual(await ledgers[3].settle('spent', 0), { settledMicroUsd: actual, replayed: true });
  });

  it('ACCEPTANCE: invalid settlement cannot release capacity; measured zero releases both role and job', async () => {
    await ledgers[0].reserve(request('reserved', 'job-one', roleKey, 100));
    for (const amount of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(ledgers[1].settle('reserved', amount), /invalid_input/);
      assert.equal((await row('reserved')).settled_micro_usd, null);
    }
    assert.equal((await ledgers[2].reserve(request('still-blocked', 'job-one', roleKey, 1))).ok, false);
    assert.deepEqual(await ledgers[3].settle('reserved', 0), { settledMicroUsd: 0, replayed: false });
    assert.equal((await ledgers[1].reserve(request('role-release', 'other-job', roleKey, 100))).ok, true);
    assert.equal((await ledgers[2].reserve(request('job-release', 'job-one', 'agent:company_operator:assurance', 100))).ok, true);
  });

  it('ACCEPTANCE: exact cap is admitted; zero cap and a single micro-USD beyond cap are denied', async () => {
    const zero = await ledgers[0].reserve(request('zero', 'zero-job', 'agent:commercial:zero', 1, 0));
    assert.equal(zero.ok, false);
    if (!zero.ok) assert.equal(zero.availableMicroUsd, 0);
    assert.equal((await ledgers[1].reserve(request('exact', 'job-one', roleKey, 100))).ok, true);
    const excess = await ledgers[2].reserve(request('one-more', 'job-one', roleKey, 1));
    assert.equal(excess.ok, false);
    if (!excess.ok) assert.equal(excess.availableMicroUsd, 0);
  });

  const spec = (purpose: string) => ({ job: fixtureJob(), role: 'commercial' as const, purpose, message: 'Return JSON.', budgetMicroUsd: 60_000, jobCapMicroUsd: 100_000, output: { name: 'reservations.v1', schema: z.object({ answer: z.string() }) } });
  function runtime(worker: number, naive: FakeNaive, delivered = new Map<string, number>()) {
    return createPostgresAgentRuntime({ db: sql.ports[worker], naive, directory, clock: new ManualClock(), workerId: `worker-${worker}`, budgetPeriodId: 'assurance', idempotencyNamespace: 'reservations', maxWaitMs: 0,
      costs: { async record(key, entry) { if (delivered.has(key)) assert.equal(delivered.get(key), entry.microUsd); delivered.set(key, entry.microUsd); } },
    });
  }

  it('ACCEPTANCE: independent runtimes reserve before dispatch; unsettled session prevents second job dispatch', async () => {
    const naive = new FakeNaive(() => ({ pollsUntilDone: 100 }));
    const outcomes = await Promise.all([runtime(0, naive).run(spec('first')), runtime(1, naive).run(spec('second'))]);
    assert.deepEqual(outcomes.map(r => r.status).sort(), ['budget_exhausted', 'pending']);
    assert.equal(naive.createCalls.length, 1);
    assert.equal(naive.createCalls[0].body.budget_micro_usd, 60_000);
    const accepted = (await sql.observer.query("SELECT * FROM agent_persistence.reservations WHERE first_result->>'ok'='true'")).rows;
    assert.equal(accepted.length, 1); assert.equal(accepted[0].settled_micro_usd, null);
  });

  it('CHARACTERIZATION: runtime completes clean output even over cap; accounts full overage and blocks next dispatch', async () => {
    const naive = new FakeNaive(() => ({ consumedMicroUsd: 150_000, structuredOutput: { answer: 'ok' } }));
    const delivered = new Map<string, number>();
    assert.equal((await runtime(0, naive, delivered).run(spec('overage'))).status, 'completed');
    assert.deepEqual([...delivered.values()], [150_000]);
    const denied = await runtime(1, naive, delivered).run(spec('after-overage'));
    assert.equal(denied.status, 'budget_exhausted');
    assert.equal(naive.createCalls.length, 1);
    const reservation = (await sql.observer.query("SELECT * FROM agent_persistence.reservations WHERE first_result->>'ok'='true'")).rows[0];
    assert.equal(Number(reservation.settled_micro_usd), 150_000);
    assert.equal((await runtime(2, naive, delivered).run(spec('overage'))).status, 'completed');
    assert.equal(delivered.size, 1); assert.equal(naive.createCalls.length, 1);
  });

  it('CHARACTERIZATION: invalid usage retains reservation; terminal operator state needs explicit manual reconciliation', async () => {
    const naive = new FakeNaive(() => ({ consumedMicroUsd: Number.NaN, structuredOutput: { answer: 'ok' } }));
    const delivered = new Map<string, number>();
    const outcome = await runtime(0, naive, delivered).run(spec('unknown-usage'));
    assert.equal(outcome.status, 'needs_operator');
    if (outcome.status === 'needs_operator') assert.equal(outcome.code, 'invalid_session_usage');
    const reservation = (await sql.observer.query("SELECT * FROM agent_persistence.reservations WHERE first_result->>'ok'='true'")).rows[0];
    assert.equal(reservation.settled_micro_usd, null); assert.equal(delivered.size, 0);
    assert.equal((await runtime(1, naive).run(spec('blocked'))).status, 'budget_exhausted');
    const session = [...naive.sessions.values()][0]; session.consumedMicroUsd = 10_000;
    const polls = naive.getCalls;
    assert.equal((await runtime(2, naive, delivered).run(spec('unknown-usage'))).status, 'needs_operator');
    assert.equal(naive.getCalls, polls); assert.equal(delivered.size, 0);
    await ledgers[3].settle(reservation.id, 10_000);
    assert.equal(Number((await row(reservation.id)).settled_micro_usd), 10_000);
    // Ledger reconciliation releases capacity, but does not deliver the original cost or resume its task.
    assert.equal((await runtime(0, naive, delivered).run(spec('unknown-usage'))).status, 'needs_operator');
    assert.equal(delivered.size, 0); assert.equal(naive.createCalls.length, 1);
    assert.equal((await runtime(1, naive).run(spec('fresh-after-reconciliation'))).status, 'needs_operator');
    assert.equal(naive.createCalls.length, 2);
  });
});

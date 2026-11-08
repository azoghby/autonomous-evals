import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { createPostgresAgentRuntime, type AgentCostSink } from '../../../../packages/core/src/agents/runtime';
import { PostgresAgentTaskStore, type AgentTransactionalSql } from '../../../../packages/core/src/agents/postgres-ports';
import { directory, FakeNaive, ManualClock, fixtureJob } from '../../../../packages/core/src/agents/__tests__/fakes';
import type { CostEntry } from '../../../../packages/core/src/evals/types';

// Real runtime and production SQL ports/migration; only the provider and app sink are fixtures.
// The app ledger implementation is absent at base 6ff8a06. This SQL sink is a contract
// fixture, NOT evidence that an application currently implements durable idempotency.
const migration = readFileSync(new URL('../../../../packages/core/src/agents/persistence-migrations/001-agent-persistence.sql', import.meta.url), 'utf8');
const spec = () => ({
  job: fixtureJob(), role: 'commercial' as const, purpose: 'cost-release-assurance',
  message: 'Return JSON.', budgetMicroUsd: 100_000, jobCapMicroUsd: 100_000,
  output: { name: 'cost-assurance.v1', schema: z.object({ answer: z.string() }) },
});

describe('acceptance: measured cost delivery to a contract-conforming local app boundary', () => {
  let sql: PGlite;
  let db: AgentTransactionalSql;
  let naive: FakeNaive;
  let sink: AgentCostSink;
  let attempts: Array<{ key: string; entry: CostEntry }>;
  let failure: 'before_commit' | 'after_commit' | null;

  // Every call constructs fresh production runtime/store/ledger objects against the same SQL.
  const runtime = () => createPostgresAgentRuntime({
    db, naive, directory, costs: sink, clock: new ManualClock(), workerId: 'cost-worker',
    budgetPeriodId: 'release-assurance', idempotencyNamespace: 'cost-assurance', maxWaitMs: 0,
  });
  beforeEach(async () => {
    sql = new PGlite();
    await sql.exec(migration);
    await sql.exec('CREATE TABLE fixture_app_costs (key text PRIMARY KEY, entry jsonb NOT NULL)');
    db = {
      query: <T>(s: string, p?: unknown[]) => sql.query<T>(s, p),
      transaction: fn => sql.transaction(tx => fn({ query: <T>(s: string, p?: unknown[]) => tx.query<T>(s, p) })),
    };
    naive = new FakeNaive(() => ({ structuredOutput: { answer: 'ok' } }));
    attempts = []; failure = null;
    sink = { async record(key, entry) {
      attempts.push({ key, entry: structuredClone(entry) });
      if (failure === 'before_commit') throw new Error('fixture_sink_before_commit');
      await db.transaction(async tx => {
        await tx.query('INSERT INTO fixture_app_costs VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING', [key, JSON.stringify(entry)]);
        // SQL jsonb equality is independent of object property order. Reject any drift
        // atomically; no overwrite or increment is permitted for an existing key.
        const { rows } = await tx.query<{ same: boolean }>('SELECT entry = $2::jsonb AS same FROM fixture_app_costs WHERE key = $1 FOR UPDATE', [key, JSON.stringify(entry)]);
        if (!rows[0]?.same) throw new Error('fixture_app_cost_identity_conflict');
      });
      if (failure === 'after_commit') throw new Error('fixture_sink_ack_lost');
    } };
  });
  afterEach(async () => { await sql?.close(); });

  async function appTotal() {
    return (await sql.query<{ count: number; total: number }>(`SELECT count(*)::int AS count,
      COALESCE(sum((entry->>'microUsd')::bigint), 0)::int AS total FROM fixture_app_costs`)).rows[0];
  }
  async function assertSingleSettlement(amount: number) {
    const { rows } = await sql.query<{ settled: string }>('SELECT settled_micro_usd::text AS settled FROM agent_persistence.reservations');
    assert.deepEqual(rows, [{ settled: String(amount) }]);
    assert.equal(naive.createCalls.length, 1);
    assert.equal(naive.getCalls, 1);
  }

  it('replays the identical measured entry/key after reconstruction without adding app spend or reservations', async () => {
    const first = await runtime().run(spec());
    assert.equal(first.status, 'completed');
    assert.deepEqual(await runtime().run(spec()), first);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0]);
    assert.equal(attempts[0].key, `naive:${attempts[0].entry.externalId}`);
    assert.equal(attempts[0].entry.jobId, spec().job.jobId);
    assert.equal(attempts[0].entry.measured, true);
    assert.deepEqual(await appTotal(), { count: 1, total: 12_345 });
    await assertSingleSettlement(12_345);
  });

  for (const phase of ['before_commit', 'after_commit'] as const) {
    it(`blocks success on ${phase} sink failure and replays the persisted cost without provider work`, async () => {
      failure = phase;
      await assert.rejects(runtime().run(spec()), phase === 'before_commit' ? /fixture_sink_before_commit/ : /fixture_sink_ack_lost/);
      assert.deepEqual(await appTotal(), { count: phase === 'before_commit' ? 0 : 1, total: phase === 'before_commit' ? 0 : 12_345 });
      await assertSingleSettlement(12_345);
      const persisted = (await sql.query<{ state: string }>("SELECT record->>'state' AS state FROM agent_persistence.tasks")).rows[0];
      assert.equal(persisted.state, 'completed');
      failure = null;
      assert.equal((await runtime().run(spec())).status, 'completed');
      assert.deepEqual(attempts[1], attempts[0]);
      assert.deepEqual(await appTotal(), { count: 1, total: 12_345 });
      await assertSingleSettlement(12_345);
    });
  }

  it('propagates same-key changed-amount rejection from the app boundary, preserving the original charge', async () => {
    const first = await runtime().run(spec());
    const store = new PostgresAgentTaskStore(db);
    const rec = await store.get(first.taskKey);
    assert.ok(rec);
    // Fault injection via the actual SQL port: a changed terminal cost under the
    // SAME session identity, not a different task/message or another provider call.
    assert.ok(await store.compareAndSet(rec.taskKey, rec.revision, { consumedMicroUsd: 12_346 }));
    await assert.rejects(runtime().run(spec()), /fixture_app_cost_identity_conflict/);
    assert.equal(attempts[1].key, attempts[0].key);
    assert.equal(attempts[1].entry.microUsd, 12_346);
    assert.deepEqual(await appTotal(), { count: 1, total: 12_345 });
    await assertSingleSettlement(12_345);
  });

  it('rejects changed task input before stale measured cost redelivery', async () => {
    const first = await runtime().run(spec());
    const changed = await runtime().run({ ...spec(), message: 'Changed request' });
    assert.equal(changed.status, 'needs_operator');
    assert.equal(changed.taskKey, first.taskKey);
    assert.equal('code' in changed && changed.code, 'task_input_changed');
    assert.equal(attempts.length, 1);
    assert.deepEqual(await appTotal(), { count: 1, total: 12_345 });
    await assertSingleSettlement(12_345);
  });

  for (const status of ['schema_failed', 'budget_paused', 'failed', 'needs_operator'] as const) {
    it(`delivers and deduplicates measured cost even for ${status}`, async () => {
      naive.setScript(() => status === 'schema_failed' ? { structuredOutput: { wrong: true } }
        : status === 'failed' ? { status: 'failed', stopReason: 'error' }
        : { stopReason: status === 'budget_paused' ? 'budget_paused' : 'awaiting_input' });
      assert.equal((await runtime().run(spec())).status, status);
      assert.equal((await runtime().run(spec())).status, status);
      assert.deepEqual(await appTotal(), { count: 1, total: 12_345 });
      assert.deepEqual(attempts[1], attempts[0]);
      await assertSingleSettlement(12_345);
    });
  }

  it('delivers measured zero as a real row, rather than treating it as unknown usage', async () => {
    naive.setScript(() => ({ consumedMicroUsd: 0, structuredOutput: { answer: 'ok' } }));
    assert.equal((await runtime().run(spec())).status, 'completed');
    await runtime().run(spec());
    assert.deepEqual(await appTotal(), { count: 1, total: 0 });
    assert.equal(attempts[0].entry.measured, true);
    await assertSingleSettlement(0);
  });

  it('holds unknown terminal usage without manufacturing or delivering a zero charge', async () => {
    naive.setScript(() => ({ consumedMicroUsd: undefined as unknown as number, structuredOutput: { answer: 'ok' } }));
    for (let i = 0; i < 2; i++) {
      const result = await runtime().run(spec());
      assert.equal(result.status, 'needs_operator');
      assert.equal('code' in result && result.code, 'invalid_session_usage');
    }
    assert.equal(attempts.length, 0);
    assert.deepEqual(await appTotal(), { count: 0, total: 0 });
    assert.equal(naive.createCalls.length, 1);
    assert.deepEqual((await sql.query('SELECT settled_micro_usd FROM agent_persistence.reservations')).rows, [{ settled_micro_usd: null }]);
  });

  it('CHARACTERIZATION: runtime forwards changed same-key amounts if the app sink accepts them', async () => {
    const accepted: Array<{ key: string; entry: CostEntry }> = [];
    sink = { async record(key, entry) { accepted.push({ key, entry }); } };
    const first = await runtime().run(spec());
    const store = new PostgresAgentTaskStore(db);
    const rec = await store.get(first.taskKey);
    assert.ok(rec);
    await store.compareAndSet(rec.taskKey, rec.revision, { consumedMicroUsd: 99_999 });
    assert.equal((await runtime().run(spec())).status, 'completed');
    assert.equal(accepted[0].key, accepted[1].key);
    assert.deepEqual(accepted.map(c => c.entry.microUsd), [12_345, 99_999]);
    await assertSingleSettlement(12_345);
    // This PASS records a boundary limitation, not acceptance of end-to-end protection.
  });
});

import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createPostgresAgentRuntime, type AgentCostSink } from '../../../packages/core/src/agents/runtime';
import { PostgresAgentTaskStore, type AgentTransactionalSql } from '../../../packages/core/src/agents/postgres-ports';
import { directory, FakeNaive, ManualClock, fixtureJob } from '../../../packages/core/src/agents/__tests__/fakes';
import { NaiveCallError, type AgentRole, type CostEntry } from '../../../packages/core/src/evals/types';

const migration = readFileSync(new URL('../../../packages/core/src/agents/persistence-migrations/001-agent-persistence.sql', import.meta.url), 'utf8');
const spec = (role: AgentRole = 'commercial', purpose = 'architecture') => ({
  job: fixtureJob(), role, purpose, message: 'Return JSON.', budgetMicroUsd: 100_000,
  output: { name: 'architecture.v1', schema: z.object({ answer: z.string() }) },
});

describe('Postgres runtime composition (PGlite SQL + fake provider, no live acceptance)', () => {
  let sql: PGlite;
  let db: AgentTransactionalSql;
  let naive: FakeNaive;
  let clock: ManualClock;
  let delivered: Map<string, CostEntry>;
  let calls: number;
  let sink: AgentCostSink;
  const runtime = () => createPostgresAgentRuntime({
    db, naive, directory, costs: sink, clock, workerId: 'worker',
    budgetPeriodId: 'hackathon', idempotencyNamespace: 'architecture', maxWaitMs: 0,
  });
  beforeEach(async () => {
    sql = new PGlite();
    await sql.exec(migration);
    await sql.exec('CREATE TABLE test_costs (key text PRIMARY KEY, entry jsonb NOT NULL)');
    db = {
      query: <T>(s: string, p?: unknown[]) => sql.query<T>(s, p),
      transaction: fn => sql.transaction(tx => fn({ query: <T>(s: string, p?: unknown[]) => tx.query<T>(s, p) })),
    };
    naive = new FakeNaive(() => ({ structuredOutput: { answer: 'ok' } }));
    clock = new ManualClock(); delivered = new Map(); calls = 0;
    sink = { async record(key, entry) {
      calls++;
      await sql.query('INSERT INTO test_costs VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING', [key, JSON.stringify(entry)]);
      const persisted = await sql.query<{ entry: CostEntry }>('SELECT entry FROM test_costs WHERE key = $1', [key]);
      expect(persisted.rows[0].entry).toEqual(entry);
      delivered.set(key, entry);
    } };
  });
  afterEach(async () => { await sql.close(); });

  it('constructs without I/O; all four roles require schemas/budgets and replay measured costs', async () => {
    const runner = runtime();
    expect(naive.createCalls).toHaveLength(0);
    for (const role of Object.keys(directory) as AgentRole[]) {
      expect((await runner.run(spec(role))).status).toBe('completed');
      expect((await runtime().run(spec(role))).status).toBe('completed');
    }
    expect(naive.createCalls).toHaveLength(4);
    expect(naive.getCalls).toBe(4);
    expect(calls).toBe(8); expect(delivered.size).toBe(4);
    expect([...delivered.values()].reduce((n, c) => n + c.microUsd, 0)).toBe(4 * 12_345);
    for (const c of naive.createCalls) {
      expect(c.body.structured_output_required).toBe(true);
      expect(c.body.output_schema).toMatchObject({ type: 'object' });
      expect(c.body.budget_micro_usd).toBe(100_000);
    }
  });

  it('replays cost delivery after an ambiguous sink commit without another provider call', async () => {
    const record = sink.record;
    sink.record = async (key, entry) => { await record(key, entry); throw new Error('ack lost'); };
    await expect(runtime().run(spec())).rejects.toThrow('ack lost');
    expect(delivered.size).toBe(1);
    sink.record = record;
    expect((await runtime().run(spec())).status).toBe('completed');
    expect(calls).toBe(2); expect(delivered.size).toBe(1);
    expect((await sql.query<{ count: number }>('SELECT count(*)::int AS count FROM test_costs')).rows[0].count).toBe(1);
    expect(naive.createCalls).toHaveLength(1); expect(naive.getCalls).toBe(1);
  });

  it.each(['schema_failed', 'budget_paused', 'failed', 'needs_operator'] as const)('delivers costs for %s outcomes', async status => {
    naive.setScript(() => status === 'schema_failed' ? { structuredOutput: { wrong: true } }
      : status === 'failed' ? { status: 'failed', stopReason: 'error' }
      : { stopReason: status === 'budget_paused' ? 'budget_paused' : 'awaiting_input' });
    expect((await runtime().run(spec())).status).toBe(status);
    expect([...delivered.values()]).toMatchObject([{ measured: true, microUsd: 12_345 }]);
    await runtime().run(spec());
    expect(delivered.size).toBe(1); expect(naive.createCalls).toHaveLength(1);
  });

  it('recovers ambiguous creation by lookup and delivers cost only when usage is known', async () => {
    naive.createFailures.set(0, { error: new NaiveCallError('ambiguous', 'timeout'), createdAnyway: true });
    expect((await runtime().run(spec())).status).toBe('pending');
    expect(delivered.size).toBe(0);
    expect((await runtime().run(spec())).status).toBe('completed');
    expect(delivered.size).toBe(1); expect(naive.createCalls).toHaveLength(1);
  });

  it.each([NaN, undefined, -1, 0.1, Number.MAX_SAFE_INTEGER + 1])('keeps reservation and blocks invalid terminal usage %s', async amount => {
    naive.setScript(() => ({ consumedMicroUsd: amount as number, structuredOutput: { answer: 'ok' } }));
    const outcome = await runtime().run({ ...spec(), jobCapMicroUsd: 100_000 });
    expect(outcome).toMatchObject({ status: 'needs_operator', code: 'invalid_session_usage' });
    expect(delivered.size).toBe(0);
    const row = await new PostgresAgentTaskStore(db).get(outcome.taskKey);
    expect(row?.consumedMicroUsd).toBeNull();
    // A second task cannot spend the held reservation, even across fresh runtime instances.
    const blocked = await runtime().run({ ...spec('commercial', 'second'), jobCapMicroUsd: 100_000 });
    expect(blocked).toMatchObject({ status: 'budget_exhausted', availableMicroUsd: 0 });
    expect(naive.createCalls).toHaveLength(1);
    expect(await runtime().run({ ...spec(), jobCapMicroUsd: 100_000 })).toMatchObject({ status: 'needs_operator', code: 'invalid_session_usage' });
  });

  it('retains the reservation when token usage is malformed', async () => {
    naive.setScript(() => ({ tokenUsage: { input: -1 }, structuredOutput: { answer: 'ok' } }));
    expect(await runtime().run(spec())).toMatchObject({ status: 'needs_operator', code: 'invalid_session_usage' });
    expect(delivered.size).toBe(0);
  });

  it('delivers measured zero without confusing it with unknown usage', async () => {
    naive.setScript(() => ({ consumedMicroUsd: 0, structuredOutput: { answer: 'ok' } }));
    expect((await runtime().run(spec())).status).toBe('completed');
    expect([...delivered.values()]).toMatchObject([{ microUsd: 0, measured: true }]);
  });

  it('preserves full measured overage, then refuses another dispatch at the job cap', async () => {
    naive.setScript(() => ({ consumedMicroUsd: 150_000, structuredOutput: { answer: 'ok' } }));
    const task = { ...spec(), jobCapMicroUsd: 100_000 };
    expect((await runtime().run(task)).status).toBe('completed');
    expect([...delivered.values()][0].microUsd).toBe(150_000);
    expect(await runtime().run({ ...task, purpose: 'next' })).toMatchObject({ status: 'budget_exhausted', availableMicroUsd: 0 });
    expect(naive.createCalls).toHaveLength(1);
  });

  it('does not deliver stale costs or dispatch for a changed same-key request', async () => {
    await runtime().run(spec());
    expect(await runtime().run({ ...spec(), message: 'Changed task' })).toMatchObject({ status: 'needs_operator', code: 'task_input_changed' });
    expect(calls).toBe(1); expect(naive.createCalls).toHaveLength(1);
  });
});

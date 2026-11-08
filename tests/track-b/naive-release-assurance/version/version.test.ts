import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { ensureAgents, buildAgentCreateBody, AgentProvisioningError } from '../../../../packages/core/src/agents/provision';
import { createPostgresAgentRuntime } from '../../../../packages/core/src/agents/runtime';
import type { AgentTransactionalSql } from '../../../../packages/core/src/agents/postgres-ports';
import { FakeNaive, ManualClock, fixtureJob } from '../../../../packages/core/src/agents/__tests__/fakes';
import { NaiveCallError, type AgentDirectory, type AgentRole, type AgentTaskRecord, type CostEntry } from '../../../../packages/core/src/evals/types';

const roles: AgentRole[] = ['commercial', 'evaluation_engineer', 'quality_investigator', 'company_operator'];
const pins = (): AgentDirectory => Object.fromEntries(roles.map((role, i) => [role, {
  agentId: `agt_${String(i + 1).padStart(26, '0')}`, agentVersion: 3,
}])) as AgentDirectory;

/** Structural in-process agent-directory port. No SDK client, HTTP, API key or provider is used. */
function provisionFixture(options: { latest?: number; exact?: number; config?: object } = {}) {
  const directory = pins();
  const calls: Array<{ method: string; id?: string; version?: number }> = [];
  const agents = roles.map(role => ({ ...buildAgentCreateBody(role), id: directory[role].agentId, current_version: 3 }));
  const port = {
    async list() { calls.push({ method: 'list' }); return { data: agents, has_more: false, next_cursor: null }; },
    async get(id: string) {
      calls.push({ method: 'get', id });
      // Latest can change between list and get, including unsafe configuration.
      return { ...agents.find(a => a.id === id)!, current_version: options.latest ?? 3, handoffs: true };
    },
    async getVersion(id: string, version: number) {
      calls.push({ method: 'getVersion', id, version });
      return { ...agents.find(a => a.id === id)!, version: options.exact ?? version, ...options.config };
    },
    async create() { throw new Error('unexpected creation'); },
  };
  return { directory, calls, client: { agents: port } as unknown as Parameters<typeof ensureAgents>[0] };
}
const spec = (purpose = 'version_probe', attempt = 1, role: AgentRole = 'commercial') => ({
  job: fixtureJob(), role, purpose, attempt, message: 'Return the requested JSON.', budgetMicroUsd: 100_000,
  output: { name: 'version-probe.v1', schema: z.object({ answer: z.string() }) },
});

// Acceptance means the named invariant is met. CHARACTERIZATION explicitly records an
// unsafe behavior at the trusted-bootstrap boundary; a passing characterization is NOT acceptance.
describe('exact provisioned version: real runtime + real local SQL + established fake provider', { concurrency: false }, () => {
  let sql: PGlite;
  let db: AgentTransactionalSql;
  let naive: FakeNaive;
  let clock: ManualClock;
  let deliveryCalls: number;
  before(async () => {
    sql = new PGlite();
    await sql.exec(readFileSync(new URL('../../../../packages/core/src/agents/persistence-migrations/001-agent-persistence.sql', import.meta.url), 'utf8'));
    await sql.exec('CREATE TABLE version_test_costs (key text PRIMARY KEY, entry jsonb NOT NULL)');
    db = {
      query: <T>(s: string, p?: unknown[]) => sql.query<T>(s, p),
      transaction: fn => sql.transaction(tx => fn({ query: <T>(s: string, p?: unknown[]) => tx.query<T>(s, p) })),
    };
  });
  after(async () => { await sql?.close(); });
  beforeEach(async () => {
    await sql.exec('TRUNCATE agent_persistence.tasks, agent_persistence.scopes, agent_persistence.reservations, version_test_costs');
    clock = new ManualClock();
    naive = new FakeNaive(body => ({ agentVersion: body.agent_version ?? 9, structuredOutput: { answer: 'ok' } }));
    deliveryCalls = 0;
  });
  const runtime = (directory: AgentDirectory) => createPostgresAgentRuntime({
    db, naive, directory, clock, workerId: 'version-worker', budgetPeriodId: 'version-period',
    idempotencyNamespace: 'version-assurance', maxWaitMs: 0,
    costs: { async record(key: string, entry: CostEntry) {
      deliveryCalls++;
      await sql.query('INSERT INTO version_test_costs VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING', [key, JSON.stringify(entry)]);
      const saved = await sql.query<{ entry: CostEntry }>('SELECT entry FROM version_test_costs WHERE key=$1', [key]);
      assert.deepEqual(saved.rows[0].entry, entry);
    } },
  });
  const rows = async () => (await sql.query<{ record: AgentTaskRecord }>('SELECT record FROM agent_persistence.tasks ORDER BY task_key')).rows.map(r => r.record);
  const evidence = async () => ({
    tasks: await rows(),
    reservations: (await sql.query<{ settled_micro_usd: number | null }>('SELECT * FROM agent_persistence.reservations ORDER BY id')).rows,
    scopes: (await sql.query('SELECT * FROM agent_persistence.scopes ORDER BY key')).rows,
    costs: (await sql.query('SELECT * FROM version_test_costs ORDER BY key')).rows,
  });

  it('ACCEPTANCE: verifies list-time exact version despite latest advancing before identity inspection', async () => {
    const h = provisionFixture({ latest: 4 });
    const verified = await ensureAgents(h.client, { dryRun: true });
    assert.deepEqual(verified.directory, h.directory);
    assert.deepEqual(verified.missing, []);
    assert.deepEqual(verified.created, []);
    assert.deepEqual(h.calls.filter(c => c.method === 'getVersion').map(c => c.version), [3, 3, 3, 3]);
    for (const role of roles) {
      const result: Awaited<ReturnType<ReturnType<typeof runtime>['run']>> = await runtime(verified.directory as AgentDirectory).run(spec('exact_pin', 1, role));
      assert.equal(result.status, 'completed');
      if (result.status === 'completed') assert.equal(result.session.agentVersion, 3);
    }
    assert.equal(naive.createCalls.length, 4);
    assert.ok(naive.createCalls.every(c => c.body.agent_version === 3));
    assert.ok((await rows()).every(r => r.requestBody.agent_version === 3 && r.agentVersion === 3));
  });

  it('ACCEPTANCE: an explicitly configured older pin never advances to current', async () => {
    const h = provisionFixture({ latest: 8 });
    const older = pins();
    for (const role of roles) older[role].agentVersion = 2;
    assert.deepEqual((await ensureAgents(h.client, { directory: older, dryRun: true })).directory, older);
    assert.ok(h.calls.filter(c => c.method === 'getVersion').every(c => c.version === 2));
  });

  it('ACCEPTANCE: rejects returned version substitution and unsafe exact configuration before dispatch', async () => {
    for (const options of [{ exact: 4 }, { config: { handoffs: true } }]) {
      const h = provisionFixture(options);
      await assert.rejects(ensureAgents(h.client, { dryRun: true }), (error: unknown) => {
        assert.ok(error instanceof AgentProvisioningError);
        assert.equal(error.diagnostic.code, 'exact' in options ? 'identity_mismatch' : 'configuration_mismatch');
        return true;
      });
      assert.ok(h.calls.every(c => c.method !== 'create'));
    }
    assert.equal(naive.createCalls.length, 0);
    assert.deepEqual(await rows(), []);
  });

  it('ACCEPTANCE: fresh runtime reuses completed SQL result only under the same exact pin', async () => {
    const directory = (await ensureAgents(provisionFixture().client, { dryRun: true })).directory as AgentDirectory;
    const first = await runtime(directory).run(spec());
    assert.equal(first.status, 'completed');
    const before = await evidence();
    assert.deepEqual(await runtime(structuredClone(directory)).run(spec()), first);
    assert.deepEqual(await evidence(), before);
    assert.equal(naive.createCalls.length, 1);
    assert.equal(naive.getCalls, 1);
    assert.equal(deliveryCalls, 2); // same measured cost is safely redelivered
  });

  for (const state of ['completed', 'created', 'ambiguous'] as const) {
    it(`ACCEPTANCE: changed exact pin blocks ${state} task reuse with zero SQL/provider/cost mutation`, async () => {
      const directory = pins();
      if (state === 'created') naive.setScript(body => ({ agentVersion: body.agent_version, pollsUntilDone: 3, structuredOutput: { answer: 'ok' } }));
      if (state === 'ambiguous') naive.createFailures.set(0, { error: new NaiveCallError('ambiguous', 'fixture timeout'), createdAnyway: true });
      await runtime(directory).run(spec());
      assert.equal((await rows())[0].state, state);
      const before = await evidence();
      const calls = [naive.createCalls.length, naive.getCalls, deliveryCalls];
      let scans = 0;
      const list = naive.listAgentSessions.bind(naive);
      naive.listAgentSessions = async (...args) => { scans++; return list(...args); };
      directory.commercial.agentVersion = 4;
      const blocked = await runtime(directory).run(spec());
      assert.equal(blocked.status, 'needs_operator');
      if (blocked.status === 'needs_operator') {
        assert.equal(blocked.code, 'task_input_changed');
        assert.match(blocked.message, /agent_version/);
      }
      assert.deepEqual(await evidence(), before);
      assert.deepEqual([naive.createCalls.length, naive.getCalls, deliveryCalls], calls);
      assert.equal(scans, 0);
    });
  }

  it('ACCEPTANCE: deliberately bumped attempt creates a new exact-version intent and reservation', async () => {
    const directory = pins();
    await runtime(directory).run(spec());
    directory.commercial.agentVersion = 4;
    assert.equal((await runtime(directory).run(spec('version_probe', 2))).status, 'completed');
    assert.deepEqual(naive.createCalls.map(c => c.body.agent_version), [3, 4]);
    assert.notEqual(naive.createCalls[0].key, naive.createCalls[1].key);
    assert.deepEqual((await rows()).map(r => r.requestBody.agent_version), [3, 4]);
    assert.equal((await evidence()).reservations.length, 2);
  });

  it('CHARACTERIZATION V1: mutating a verified directory before first dispatch silently selects an unverified version', async () => {
    const h = provisionFixture();
    const directory = (await ensureAgents(h.client, { dryRun: true })).directory as AgentDirectory;
    const runner = runtime(directory);
    const verificationCalls = h.calls.length;
    directory.commercial.agentVersion = 4; // no getVersion(4) occurred
    const result = await runner.run(spec());
    assert.equal(result.status, 'completed');
    assert.equal(naive.createCalls[0].body.agent_version, 4);
    assert.equal((await rows())[0].requestBody.agent_version, 4);
    assert.equal(h.calls.length, verificationCalls);
    assert.ok(!h.calls.some(c => c.version === 4));
  });

  it('CHARACTERIZATION V2: runtime accepts a directory with omitted version and durably reuses an unpinned result', async () => {
    const directory = pins();
    delete directory.commercial.agentVersion;
    const first = await runtime(directory).run(spec());
    assert.equal(first.status, 'completed');
    if (first.status === 'completed') assert.equal(first.session.agentVersion, 9);
    assert.equal(Object.hasOwn(naive.createCalls[0].body, 'agent_version'), false);
    assert.equal(Object.hasOwn((await rows())[0].requestBody, 'agent_version'), false);
    assert.deepEqual(await runtime(directory).run(spec()), first);
    assert.equal(naive.createCalls.length, 1);
    assert.equal(naive.getCalls, 1);
  });

  it('CHARACTERIZATION V3-poll: a version change first observed during polling overwrites the adopted exact version', async () => {
    const directory = pins();
    naive.setScript(() => ({ agentVersion: 3, pollsUntilDone: 1, structuredOutput: { answer: 'ok' } }));
    assert.equal((await runtime(directory).run(spec())).status, 'pending');
    const row = (await rows())[0];
    assert.equal(row.agentVersion, 3);
    assert.equal(row.requestBody.agent_version, 3);
    naive.sessions.get(row.sessionId!)!.agentVersion = 4;
    const result = await runtime(directory).run(spec());
    assert.equal(result.status, 'completed');
    if (result.status === 'completed') assert.equal(result.session.agentVersion, 4);
    assert.equal((await rows())[0].agentVersion, 4);
    assert.equal(naive.createCalls.length, 1);
    assert.equal((await evidence()).costs.length, 1);
  });

  it('CHARACTERIZATION V3-recovery: lookup adopts a wrong-version session under the unchanged task pin', async () => {
    const directory = pins();
    naive.setScript(() => ({ agentVersion: 4, structuredOutput: { answer: 'ok' } }));
    naive.createFailures.set(0, { error: new NaiveCallError('ambiguous', 'fixture timeout'), createdAnyway: true });
    assert.equal((await runtime(directory).run(spec())).status, 'pending');
    assert.equal((await rows())[0].state, 'ambiguous');
    const result = await runtime(directory).run(spec());
    assert.equal(result.status, 'completed');
    if (result.status === 'completed') assert.equal(result.session.agentVersion, 4);
    assert.equal((await rows())[0].requestBody.agent_version, 3);
    assert.equal((await rows())[0].agentVersion, 4);
    assert.equal(naive.createCalls.length, 1); // lookup recovery, no replay
    assert.equal((await evidence()).costs.length, 1);
  });

  it('CHARACTERIZATION V3: mismatched returned version is completed, settled, delivered and reused against the verified pin', async () => {
    const directory = (await ensureAgents(provisionFixture().client, { dryRun: true })).directory as AgentDirectory;
    naive.setScript(() => ({ agentVersion: 4, structuredOutput: { answer: 'wrong version' } }));
    const first = await runtime(directory).run(spec());
    assert.equal(first.status, 'completed');
    if (first.status === 'completed') {
      assert.equal(first.session.agentVersion, 4);
      assert.deepEqual(first.output, { answer: 'wrong version' });
    }
    const row = (await rows())[0];
    assert.equal(row.requestBody.agent_version, 3);
    assert.equal(row.agentVersion, 4);
    assert.equal(row.state, 'completed');
    assert.equal((await evidence()).reservations[0].settled_micro_usd, 12_345);
    assert.equal((await evidence()).costs.length, 1);
    assert.deepEqual(await runtime(directory).run(spec()), first);
    assert.equal(naive.createCalls.length, 1);
    assert.equal(naive.getCalls, 1);
  });
});

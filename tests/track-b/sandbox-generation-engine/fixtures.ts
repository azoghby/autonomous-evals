import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import type { AgentSqlExecutor, AgentTransactionalSql } from '../../../packages/core/src/agents/postgres-ports';

/** Independent native PostgreSQL backends on a disposable Unix socket. No TCP or downloads. */
export async function localPostgres() {
  const installed = '/tmp/agent-persistence-runtime/node_modules/@embedded-postgres/darwin-arm64/native/bin';
  const bin = process.env.CONTINUATION_PG_BIN ?? (existsSync(installed) ? installed : '');
  const work = mkdtempSync(join(tmpdir(), 'continuation-sql-'));
  const data = join(work, 'data');
  const command = (name: string, args: string[]) => {
    const result = spawnSync(bin ? join(bin, name) : name, args, { encoding: 'utf8', timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(`${name}: ${result.error?.message ?? result.stderr}. Set CONTINUATION_PG_BIN to installed native PostgreSQL binaries; this suite never downloads them.`);
  };
  let clients: pg.Client[] = [];
  let running = false;
  const connect = async () => {
    const client = new pg.Client({ host: work, database: 'postgres', user: 'postgres', connectionTimeoutMillis: 5000, query_timeout: 10_000 });
    await client.connect(); clients.push(client);
    await client.query("SET statement_timeout = '8s'; SET lock_timeout = '6s'");
    return client;
  };
  const port = (client: pg.Client): AgentTransactionalSql => ({
    query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as T[] }),
    transaction: async <T>(fn: (tx: AgentSqlExecutor) => Promise<T>): Promise<T> => {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      try {
        const result = await fn({ query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as R[] }) });
        await client.query('COMMIT'); return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
    },
  });
  const opened = async () => {
    const sessions = await Promise.all([connect(), connect(), connect()]);
    return { observer: sessions[2], ports: sessions.slice(0, 2).map(port) };
  };
  try {
    command('initdb', ['-D', data, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8', '--locale=C']);
    command('pg_ctl', ['-D', data, '-l', join(work, 'postgres.log'), '-o', `-h '' -k ${work} -c fsync=on -c synchronous_commit=on`, '-w', 'start']);
    running = true;
    const initial = await opened();
    for (const file of ['agents/persistence-migrations/001-agent-persistence.sql', 'evals/integration/migrations/001-text-integration.sql']) {
      await initial.observer.query(readFileSync(new URL(`../../../packages/core/src/${file}`, import.meta.url), 'utf8'));
    }
    return {
      ...initial,
      async restart() {
        await Promise.all(clients.map(client => client.end())); clients = [];
        command('pg_ctl', ['-D', data, '-l', join(work, 'postgres.log'), '-m', 'fast', '-w', 'restart']);
        return opened();
      },
      async close() {
        await Promise.all(clients.map(client => client.end())); clients = [];
        command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); running = false;
        rmSync(work, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await Promise.allSettled(clients.map(client => client.end()));
    if (running) command('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    rmSync(work, { recursive: true, force: true }); throw error;
  }
}

import { AgentSessionService } from '../../../packages/core/src/agents/session-service';
import { PostgresAgentTaskStore, PostgresBudgetLedger } from '../../../packages/core/src/agents/postgres-ports';
import type { JobRef, NaiveSessionSnapshot, NaiveSessionsPort } from '../../../packages/core/src/evals/types';
import { createDurableSandboxEngine, type DurableSandboxEngineConfig } from '../../../packages/core/src/evals/sandbox/persistence/engine';
import type { PostgresSandboxPersistenceConfig } from '../../../packages/core/src/evals/sandbox/persistence';
import type { SandboxGenerationRequest } from '../../../packages/core/src/evals/sandbox/generation/adapter';
import { gateFixture, versions } from '../sandbox-integration/sql-fixtures';

/** Real durable engine, session/task/budget SQL and SQL oracle/null/mutation gates.
 * The provider protocol is controlled locally; this fixture never creates a network client. */
export async function engineFixture() {
  const database = await localPostgres(), f = await gateFixture();
  let creates = 0, polls = 0, gates = 0, costs = 0, target = 0;
  let running = true, authorized = true;
  const sessions = new Map<string, NaiveSessionSnapshot>();
  const job: JobRef = { jobId: 'sql-job', customerId: 'owner', package: 'workflow_eval', environment: 'test', isFixture: true, quoteVersion: null, linkedRetestOf: null };
  const naive: NaiveSessionsPort = {
    async createSession(body) {
      creates++;
      const snapshot: NaiveSessionSnapshot = { id: `engine_session_${creates}`, agentId: body.agent_id, agentVersion: 1, status: 'running', stopReason: null, stopCode: null,
        structuredOutput: { scenario: f.s }, budgetMicroUsd: body.budget_micro_usd, consumedMicroUsd: 7, tokenUsage: {}, metadata: body.metadata };
      sessions.set(snapshot.id, snapshot); return snapshot;
    },
    async getSession(id) { polls++; return { ...sessions.get(id)!, status: running ? 'running' : 'idle', stopReason: running ? null : 'end_turn' }; },
    async listAgentSessions() { return { data: [...sessions.values()], nextCursor: null }; },
  };
  const start = f.ports.startRun, execute = f.ports.execute;
  f.ports.startRun = async input => { gates++; return start(input); };
  f.ports.execute = async input => { target++; return execute(input); };
  const request = (operationKey: string): SandboxGenerationRequest => ({ operationKey, environment: structuredClone(f.input.environment), slots: [{ id: 'quote', workflowId: 'quote', category: 'happy_path', expectRefusal: false, policyRefs: [{ docId: 'rules', clauseId: 'read' }] }] });
  const make = (db: AgentTransactionalSql = database.ports[0], workerId = 'worker', executionIdentity = 'fixture-engine-v1') => {
    const service = new AgentSessionService({ naive, store: new PostgresAgentTaskStore(db), ledger: new PostgresBudgetLedger(db),
      directory: { evaluation_engineer: { agentId: 'fixture_engineer', agentVersion: 1 }, commercial: { agentId: 'unused' }, quality_investigator: { agentId: 'unused' }, company_operator: { agentId: 'unused' } },
      budgetPeriodId: 'fixture_period', idempotencyNamespace: 'fixture_namespace', workerId, maxWaitMs: 0 });
    const persistenceConfig: PostgresSandboxPersistenceConfig = { db, scope: { tenantId: job.customerId, jobId: job.jobId, environmentId: f.input.environment.id }, authorize: async () => authorized };
    const config: DurableSandboxEngineConfig = {
      scope: { jobId: job.jobId, environmentId: f.input.environment.id },
      generation: { job: structuredClone(job), runner: service, sessionCapMicroUsd: 100, jobCapMicroUsd: 100_000, bindOperation: async () => 'bound', onMeasuredCost: async () => { costs++; } },
      generationContinuation: { executionIdentity },
      gateVersions: structuredClone(f.input.versions), gateEvalVersions: versions(), gates: f.ports,
      gateEvidence: async ({run}) => ({ completeDiff: { runId: run.runId, allTables: true } }),
      approvals: { resolve: async () => null },
      execution: {} as never,
      authority: { authorize: async () => authorized, finalSnapshot: async () => { throw Error('generation must not run trials'); } },
    };
    return { engine: createDurableSandboxEngine(config, persistenceConfig), config, persistenceConfig };
  };
  return { database, request, make, counts: () => ({ creates, polls, gates, costs, target }), complete: () => { running = false; }, revoke: () => { authorized = false; },
    close: async () => { await f.close(); await database.close(); } };
}

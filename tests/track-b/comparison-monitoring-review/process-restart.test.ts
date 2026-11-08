/** Offline process restart: two separate Node/Vitest processes share only local disk SQL. */
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { makeSuite } from '../src/evals/text/__tests__/fixtures';
import { executeSuite } from '../src/evals/text/execute';
import { evaluateObjectiveCheck } from '../src/evals/text/objective';
import { createComparisonMonitoringService, createRetainedComparisonAdapter } from '../src/monitoring';
import { PostgresTextCheckpointStore } from '../src/evals/integration/checkpoints';
import type { AgentTransactionalSql } from '../src/agents/postgres-ports';

it('Acceptance: completed composition survives separate Node processes without redispatch', async () => {
  const phase = process.env.COMPARISON_REVIEW_WORKER_PHASE;
  if (!phase) {
    const path = await mkdtemp(join(tmpdir(), 'comparison-process-fixture-'));
    try {
      for (const workerPhase of ['seed', 'replay']) {
        const result = spawnSync(process.execPath, [join(process.cwd(), 'node_modules/vitest/vitest.mjs'), 'run', '--root', process.cwd(), 'review/process-restart.test.ts', '--maxWorkers=1'], {
          cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
          env: { ...process.env, COMPARISON_REVIEW_WORKER_PHASE: workerPhase, COMPARISON_REVIEW_SQL_PATH: path },
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
      }
    } finally { await rm(path, { recursive: true, force: true }); }
    return;
  }
  expect(['seed', 'replay']).toContain(phase);
  const pg = new PGlite(process.env.COMPARISON_REVIEW_SQL_PATH!);
  try {
    await pg.exec(readFileSync(new URL('../src/evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
    const db: AgentTransactionalSql = { query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params), transaction: fn => pg.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })) };
    const suite = makeSuite();
    const execution = { target: { send: async () => ({ ok: true as const, text: 'READY', latencyMs: 1 }) }, judge: null, evaluateObjective: evaluateObjectiveCheck };
    const originalPath = join(process.env.COMPARISON_REVIEW_SQL_PATH!, 'retained-baseline.json');
    const original = phase === 'replay' ? JSON.parse(readFileSync(originalPath, 'utf8')) : { kind: 'text' as const, suite, run: await executeSuite(suite, 'process-fixture-original', execution), investigation: { fixture: true }, limitations: ['Local fixture only'], costs: [], unknownCosts: ['No billable fixture provider'] };
    if (phase === 'seed') writeFileSync(originalPath, JSON.stringify(original));
    let dispatches = 0;
    const current = { getSuite: async () => suite, execute: async ({ operationId }: { operationId: string }) => {
      dispatches++; if (phase === 'replay') throw new Error('Redispatch forbidden after process restart');
      return { ...original, run: await executeSuite(suite, operationId, execution) };
    } };
    const service = createComparisonMonitoringService({ checkpoints: new PostgresTextCheckpointStore(db), resolve: async () => ({ tenantId: 'fixture-tenant', jobId: suite.jobId, environment: 'test', isFixture: true, suite,
      scenarioIds: suite.scenarios.map(s => s.id), baseline: { version: 'v1', targetId: 'fixture-target-1', branchId: null, adapter: createRetainedComparisonAdapter(original) },
      current: { version: 'v2', targetId: 'fixture-target-2', branchId: null, adapter: current } }) });
    const result = await service.compare({ jobId: suite.jobId, environment: 'test', budgetMicroUsd: 0, recordCost: async () => {}, recordProgress: async () => {} }, {
      operationId: 'process-fixture-tick', baselineVersion: 'v1', currentVersion: 'v2', mode: 'monitoring',
    });
    expect(result.baseline.artifact.run.runId).toBe('process-fixture-original');
    expect(result.comparison.currentCounts.passed).toBe(12);
    expect(dispatches).toBe(phase === 'seed' ? 1 : 0);
  } finally { await pg.close(); }
}, 60_000);

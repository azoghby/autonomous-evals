import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { AgentTransactionalSql } from './src/agents/postgres-ports';
import type { ServiceContext } from './src/contracts/services';
import type { JobRef } from './src/evals/types';
import { createCalendarEvaluationServices } from './src/evals/calendar-integration';
import { PostgresTextCheckpointStore } from './src/evals/integration/checkpoints';
import { createPostgresEvaluationDataStore } from './src/evals/data/postgres-store';
import { calendarAcceptanceScenarios } from './src/simulator/acceptance-scenarios';
import { CalendarSimulator } from './src/simulator/calendar';
import { PostgresCalendarStore } from './src/simulator/postgres';
import type { SqlPool } from './src/simulator/pool';
import { createDurableProgressProjection, createDurableProgressReader } from './src/reporting/chat/projection';
import type { ProjectionPlan } from './src/reporting/chat/projection/types';

/** Stage this module beside src/, as existing Track B runners do. No provider is instantiated. */
export async function calendarPhaseOrderingCase(fixed: boolean) {
  const pg = new PGlite();
  try {
    for (const migration of [
      'evals/integration/migrations/001-text-integration.sql',
      'simulator/migrations/001_calendar.sql',
      'simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql',
    ]) await pg.exec(readFileSync(new URL(`./src/${migration}`, import.meta.url), 'utf8'));
    const db: AgentTransactionalSql = {
      query: (q, p) => pg.query(q, p),
      transaction: fn => pg.transaction(tx => fn({ query: (q, p) => tx.query(q, p) })),
    };
    // PGlite has no session advisory locks. Single sequential caller only; journal
    // reads/writes and simulator/checkpoint persistence still execute actual SQL.
    const pool: SqlPool = { query: (q, p) => pg.query(q, p), connect: async () => ({
      query: async (q, p) => q.includes('pg_advisory_unlock') ? { rows: [{ unlocked: true }] }
        : q.includes('pg_advisory_lock') ? { rows: [] } : pg.query(q, p), release: () => {},
    }) };
    const job: JobRef = { jobId: fixed ? 'ordering-fixed' : 'ordering-noop', customerId: 'ordering-local',
      package: 'workflow_eval', environment: 'test', isFixture: true, quoteVersion: null, linkedRetestOf: null };
    const ctx: ServiceContext = { jobId: job.jobId, environment: 'test', budgetMicroUsd: 0,
      recordCost: async () => {}, recordProgress: async () => {} };
    // The production freeze schema requires exactly twelve scenarios; retain that
    // minimum valid suite, exercising only the Calendar-to-projection seam.
    const fixtures = calendarAcceptanceScenarios();
    let dispatches = 0;
    const restart = () => createCalendarEvaluationServices({ checkpoints: new PostgresTextCheckpointStore(db), journalPool: pool,
      resolve: async () => ({ job, targetVersion: 'v1', branch: { jobId: job.jobId, branchId: 'branch', targetVersion: 'v1' },
        systemPrompt: '', reviewedSuite: { jobId: job.jobId, origin: 'internal_fixture', frozenAt: '2026-11-07T20:00:00.000Z',
          review: { reviewerId: 'local-reviewer', approved: true }, scenarios: fixtures.map(({ id, prompt, actorId, seed, checks }) => ({ id, prompt, actorId, seed, checks })) },
        dependencies: { db, simulator: new CalendarSimulator(new PostgresCalendarStore(db)), targetForScenario: scenario => ({ complete: async messages => {
          dispatches++;
          return !fixed || messages.some(m => m.role === 'tool') ? { role: 'assistant', content: 'No further action.' }
            : { role: 'assistant', content: null, tool_calls: structuredClone(fixtures.find(f => f.id === scenario.id)!.referenceCalls) };
        } }) },
      }) });
    const request = { suiteId: 'suite', operationId: 'baseline', versionLabel: 'v1' };
    const suite = await restart().freezeSuite(ctx, request);
    const run = await restart().runSuite(ctx, request);
    const investigation = await restart().investigate(ctx, request);
    const expected = fixed ? 'passed' : 'product_failure';
    assert.equal(run.results.length, 12);
    assert.ok(run.results.some(r => r.outcome === expected));
    if (fixed) assert.ok(run.results.every(r => r.outcome === 'passed' && r.stateGrade?.passed));
    assert.equal(investigation.reproductions.length, fixed ? 0 : 3);
    assert.equal(investigation.findings.length, fixed ? 0 : run.results.filter(r => r.outcome !== 'passed').length);
    const rows = await pg.query<{ kind: string; id: string; input_digest: string }>(
      "SELECT kind,id,input_digest FROM text_integration.checkpoints WHERE job_id=$1 AND kind IN ('calendar_run','calendar_investigation')", [job.jobId]);
    assert.equal(rows.rows.length, 2);
    const plan: ProjectionPlan = { scope: { subjectId: 'owner', jobId: job.jobId }, environment: 'test', acquisitionTaskIds: [],
      checkpoints: ['calendar_run', 'calendar_investigation'].map(kind => {
        const row = rows.rows.find(r => r.kind === kind)!;
        return { key: { jobId: job.jobId, kind, id: row.id, inputDigest: row.input_digest },
          phase: kind === 'calendar_run' ? 'running' : 'investigating', format: kind as 'calendar_run' | 'calendar_investigation',
          runId: run.runId, branchId: run.branchId, suiteDigest: suite.hash, scenarioIds: run.results.map(r => r.scenarioId) };
      }) };
    await pg.exec('CREATE TABLE ordering_jobs(job_id text PRIMARY KEY,status text,updated_at text)');
    await pg.query('INSERT INTO ordering_jobs VALUES($1,$2,$3)', [job.jobId, 'running', '2026-11-07T20:00:00.000Z']);
    const reader = createDurableProgressReader({ withRead: (p, read) => db.transaction(async tx => {
      const stored = (await tx.query<{ status: 'running'; updated_at: string }>('SELECT status,updated_at FROM ordering_jobs WHERE job_id=$1', [p.scope.jobId])).rows[0]!;
      return read({ observedAt: '2026-11-07T20:00:00.000Z', job: { jobId: p.scope.jobId, status: stored.status, updatedAt: stored.updated_at },
        costs: [], unknownCosts: true, checkpoints: new PostgresTextCheckpointStore({ ...db, query: tx.query }),
        acquisition: createPostgresEvaluationDataStore({ ...db, query: tx.query }, { tenantId: job.customerId, jobId: job.jobId }) });
    }) });
    const access = { authenticate: async () => ({ subjectId: 'owner' }), resolveAuthorizedJob: async () => plan.scope };
    const observed = new Set<string>();
    let legacyAssertionFailures = 0;
    // Vary only the local HMAC key, keeping SQL artifacts identical. This exposes
    // both hash orders deterministically without relying on UUID luck/test order.
    for (let n = 0; n < 128 && observed.size < 2; n++) {
      const projection = () => createDurableProgressProjection({ access, reader, resolve: async () => plan,
        referenceKey: `ordering-local-reference-key-32-bytes-${n}` });
      const result = await projection().project(plan.scope);
      assert.equal(result.phases.length, 2);
      assert.equal(result.snapshot.status, 'running');
      assert.deepEqual(result.phases.find(p => p.phase === 'running')?.outcomes, run.results.map(r => r.outcome));
      assert.deepEqual(result.phases.find(p => p.phase === 'investigating')?.outcomes, [...(investigation.findings.some(f => f.status === 'inconclusive') ? ['inconclusive'] : []),
        ...investigation.reproductions.map(r => r.result.outcome)]);
      assert.deepEqual(result.phases.map(p => p.evidenceRef), result.phases.map(p => p.evidenceRef).sort((a, b) => a.localeCompare(b)));
      observed.add(result.phases[0]!.phase);
      if (!result.phases[0]!.outcomes.includes(expected)) legacyAssertionFailures++;
      // Reordering the inventory and recreating the projection changes no result.
      plan.checkpoints.reverse();
      assert.deepEqual(await projection().project(plan.scope), result);
    }
    assert.deepEqual([...observed].sort(), ['investigating', 'running']);
    if (fixed) assert.ok(legacyAssertionFailures > 0, 'must independently reproduce A5 [] versus passed');
    else assert.equal(legacyAssertionFailures, 0, 'no-op investigation also has product_failure, masking the assumption');
    const dispatched = dispatches;
    assert.deepEqual(await restart().runSuite(ctx, request), run);
    assert.deepEqual(await restart().investigate(ctx, request), investigation);
    assert.equal(dispatches, dispatched);
    return { expected, observedFirstPhases: [...observed].sort(), legacyAssertionFailures, dispatches };
  } finally { await pg.close(); }
}

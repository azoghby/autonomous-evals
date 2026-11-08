import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { AgentTransactionalSql } from '../../../../packages/core/src/agents/postgres-ports';
import type { ServiceContext } from '../../../../packages/core/src/contracts/services';
import type { JobRef } from '../../../../packages/core/src/evals/types';
import { PostgresTextCheckpointStore } from '../../../../packages/core/src/evals/integration/checkpoints';
import { createCalendarEvaluationServices } from '../../../../packages/core/src/evals/calendar-integration';
import { CalendarSimulator } from '../../../../packages/core/src/simulator/calendar';
import { PostgresCalendarStore } from '../../../../packages/core/src/simulator/postgres';
import { calendarAcceptanceScenarios } from '../../../../packages/core/src/simulator/acceptance-scenarios';
import type { SqlPool } from '../../../../packages/core/src/simulator/pool';
import type { ChatTarget } from '../../../../packages/core/src/targets/chat';
import { renderCalendarReport } from '../../../../packages/core/src/reporting/calendar';
import { createDurableProgressReader } from '../../../../packages/core/src/reporting/chat/projection/reader';
import { createDurableProgressProjection } from '../../../../packages/core/src/reporting/chat/projection';
import type { ProjectionPlan } from '../../../../packages/core/src/reporting/chat/projection/types';

const at = '2026-11-07T20:00:00.000Z';
const request = { suiteId: 'calendar-reviewed', operationId: 'calendar-release', versionLabel: 'baseline' };
type Mode = 'reference' | 'noop' | 'infra' | 'reproduction-infra';

async function fixture(mode: Mode) {
  const engine = new PGlite();
  try {
    for (const path of ['simulator/migrations/001_calendar.sql', 'simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql', 'evals/integration/migrations/001-text-integration.sql']) {
      await engine.exec(readFileSync(new URL('../../../../packages/core/src/' + path, import.meta.url), 'utf8'));
    }
    const db: AgentTransactionalSql = {
      query: (sql, params) => engine.query(sql, params),
      transaction: fn => engine.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params) })),
    };
    // Only advisory functions are intercepted: PGlite has one backend.
    const pool: SqlPool = { query: (sql, params) => engine.query(sql, params), connect: async () => ({
      query: async (sql, params) => sql.includes('pg_advisory_unlock') ? { rows: [{ unlocked: true }] }
        : sql.includes('pg_advisory_lock') ? { rows: [] } : engine.query(sql, params), release() {},
    }) };
    const job: JobRef = { jobId: randomUUID(), customerId: 'calendar-local-release', package: 'workflow_eval', environment: 'test', isFixture: true, quoteVersion: null, linkedRetestOf: null };
    const ctx: ServiceContext = { jobId: job.jobId, environment: 'test', budgetMicroUsd: 0, recordCost: async () => {}, recordProgress: async () => {} };
    const scenarios = calendarAcceptanceScenarios();
    let calls = 0;
    const restart = () => createCalendarEvaluationServices({ checkpoints: new PostgresTextCheckpointStore(db), journalPool: pool,
      resolve: async () => ({ job, targetVersion: 'calendar-target-v1', branch: { jobId: job.jobId, branchId: 'calendar-branch', targetVersion: 'calendar-target-v1' },
        reviewedSuite: { jobId: job.jobId, origin: 'internal_fixture', frozenAt: at, review: { reviewerId: 'local-reviewer', approved: true },
          scenarios: scenarios.map(({ id, prompt, actorId, seed, checks }) => structuredClone({ id, prompt, actorId, seed, checks })) },
        systemPrompt: 'Local calendar test.', dependencies: { db, simulator: new CalendarSimulator(new PostgresCalendarStore(db)),
          targetForScenario: scenario => ({ complete: async messages => {
            calls++;
            if (mode === 'infra' || mode === 'reproduction-infra' && calls > 12) throw new Error('local target unavailable');
            if (mode !== 'reference') return { role: 'assistant', content: 'No action performed.' };
            return messages.some(m => m.role === 'tool') ? { role: 'assistant', content: 'Reference completed.' }
              : { role: 'assistant', content: null, tool_calls: structuredClone(scenarios.find(s => s.id === scenario.id)!.referenceCalls) };
          } } satisfies ChatTarget) },
      }),
    });
    await restart().freezeSuite(ctx, request);
    const run = await restart().runSuite(ctx, request);
    const investigation = await restart().investigate(ctx, request);
    const report = await restart().reportInput(ctx, request);
    const scope = { subjectId: 'calendar-reviewer', jobId: job.jobId };
    const rows = await engine.query<{ kind: 'calendar_run' | 'calendar_investigation'; input_digest: string }>(
      "SELECT kind, input_digest FROM text_integration.checkpoints WHERE job_id = $1 AND kind IN ('calendar_run', 'calendar_investigation')", [job.jobId]);
    assert.equal(rows.rows.length, 2);
    // Expected associations come from the actual authorized durable operation.
    const plan: ProjectionPlan = { scope, environment: 'test', acquisitionTaskIds: [], checkpoints: rows.rows.map(row => ({
      key: { jobId: job.jobId, kind: row.kind, id: request.operationId, inputDigest: row.input_digest },
      format: row.kind, phase: row.kind === 'calendar_run' ? 'running' : 'investigating',
      runId: run.runId, branchId: run.branchId, suiteDigest: run.suiteHash, scenarioIds: run.results.map(r => r.scenarioId),
    })) };
    let status: 'running' | 'delivered' = 'running';
    const reader = createDurableProgressReader({ withRead: (_plan, read) => db.transaction(tx => read({
      observedAt: at, job: { jobId: job.jobId, status, updatedAt: at }, costs: [], unknownCosts: true,
      checkpoints: new PostgresTextCheckpointStore({ query: tx.query.bind(tx), transaction: async fn => fn(tx) }),
      acquisition: { get: async () => { throw new Error('no acquisition planned'); } },
    })) });
    const project = () => createDurableProgressProjection({ referenceKey: 'local-fixture-reference-key-32-bytes-only',
      access: { authenticate: async () => ({ subjectId: scope.subjectId }), resolveAuthorizedJob: async () => scope },
      resolve: async () => plan, reader,
    }).project(scope);
    return { engine, job, ctx, run, investigation, report, plan, project, restart, calls: () => calls, deliver: () => { status = 'delivered'; } };
  } catch (error) { await engine.close(); throw error; }
}

export async function calendarIdentityReplayCase() {
  const f = await fixture('noop');
  try {
    const count = f.calls();
    assert.equal(f.run.results.length, 12);
    assert.equal(new Set(f.run.results.map(r => r.scope.runId)).size, 12);
    assert(f.run.results.every(r => r.scope.runId !== f.run.runId));
    assert.deepEqual(f.investigation.original, f.run);
    assert.equal(f.investigation.reproductions.length, 3);
    assert.equal(f.investigation.findings.filter(x => x.status === 'confirmed').length, 3);
    assert.deepEqual(await f.restart().runSuite(f.ctx, request), f.run);
    assert.deepEqual(await f.restart().investigate(f.ctx, request), f.investigation);
    assert.deepEqual(await f.restart().reportInput(f.ctx, request), f.report);
    const rendered = renderCalendarReport({ job: f.job, report: f.report, generatedAt: at, costs: null, includeHtml: true });
    assert.deepEqual(rendered.json.details.calendar, { suite: f.report.suite, run: f.run, investigation: f.investigation, monitoring: f.report.monitoring, status: f.report.status });
    assert.deepEqual(f.report.monitoring.checks.map(c => c.evidenceIds), f.run.results.map(r => [`calendar:${r.scope.runId}`]));
    const projected = await f.project();
    assert.equal(projected.snapshot.findings.filter(x => x.status === 'confirmed').length, 3);
    assert(projected.snapshot.findings.some(x => x.status === 'inconclusive')); // Bounded, unreproduced failures remain unresolved.
    assert(projected.snapshot.blockers.length > 0);
    assert.deepEqual(await f.project(), projected);
    assert.equal(f.calls(), count);
  } finally { await f.engine.close(); }
}

export async function calendarUnresolvedCase(mode: 'infra' | 'reproduction-infra') {
  const f = await fixture(mode);
  try {
    const count = f.calls();
    assert.equal(f.report.status, 'unresolved');
    if (mode === 'infra') {
      assert(f.run.results.every(r => r.outcome === 'infrastructure_error'));
      assert(f.report.monitoring.checks.every(c => c.outcome === 'infrastructure_error'));
      assert.equal(f.investigation.reproductions.length, 0);
    } else {
      assert.equal(f.investigation.reproductions.length, 3);
      assert(f.investigation.reproductions.every(r => r.result.outcome === 'infrastructure_error'));
    }
    assert(f.investigation.findings.every(x => x.status === 'inconclusive'));
    const rendered = renderCalendarReport({ job: f.job, report: f.report, generatedAt: at, costs: null });
    assert.deepEqual(rendered.json.details.calendar, { suite: f.report.suite, run: f.run, investigation: f.investigation, monitoring: f.report.monitoring, status: 'unresolved' });
    const progress = await f.project();
    assert(progress.snapshot.blockers.length > 0);
    assert(progress.phases.some(p => p.outcomes.includes('infrastructure_error')));
    assert(progress.snapshot.findings.every(x => x.status === 'inconclusive'));
    f.deliver();
    await assert.rejects(f.project(), { code: 'invalid_snapshot' });
    assert.equal(f.calls(), count);
  } finally { await f.engine.close(); }
}

export async function calendarCleanControlCase() {
  const f = await fixture('reference');
  try {
    assert(f.run.results.every(r => r.outcome === 'passed'));
    assert.equal(f.report.status, 'completed');
    assert.equal(f.report.findings.length, 0);
    assert.equal((await f.project()).snapshot.blockers.length, 0);
    f.deliver();
    assert.equal((await f.project()).snapshot.status, 'delivered');
  } finally { await f.engine.close(); }
}

export async function calendarIdentityRejectionCase() {
  const f = await fixture('noop');
  try {
    const calls = f.calls();
    // Each probe changes trusted expected identity, leaving durable evidence unchanged.
    for (const field of ['runId', 'branchId', 'suiteDigest'] as const) {
      const prior = f.plan.checkpoints[1]![field];
      f.plan.checkpoints[1]![field] = 'foreign-identity';
      await assert.rejects(f.project(), { code: 'invalid_snapshot' });
      f.plan.checkpoints[1]![field] = prior;
    }
    const prior = f.plan.checkpoints[0]!.key.inputDigest;
    f.plan.checkpoints[0]!.key.inputDigest = 'f'.repeat(64);
    await assert.rejects(f.project(), { code: 'invalid_snapshot' });
    f.plan.checkpoints[0]!.key.inputDigest = prior;
    await assert.rejects(f.restart().reportInput(f.ctx, { ...request, versionLabel: 'other-version' }));
    const detached = structuredClone(f.report);
    detached.run.branchId = 'foreign-branch';
    assert.throws(() => renderCalendarReport({ job: f.job, report: detached, generatedAt: at, costs: null }));
    await f.project();
    assert.equal(f.calls(), calls);
  } finally { await f.engine.close(); }
}

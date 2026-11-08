/** Internal local calendar fixtures; real SQL simulator, no providers or cloud. */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { calendarAcceptanceScenarios } from '../src/simulator/acceptance-scenarios';
import { CalendarSimulator } from '../src/simulator/calendar';
import { PostgresCalendarStore, type TransactionalDatabase } from '../src/simulator/postgres';
import { freezeCalendarSuite, runCalendarSuite } from '../src/simulator/workflow';
import { PostgresTextCheckpointStore } from '../src/evals/integration/checkpoints';
import { createComparisonMonitoringService, type RichEvaluationAdapter } from '../src/monitoring';
import type { AgentTransactionalSql } from '../src/agents/postgres-ports';

it('composes actual calendar fixture runs on one reviewed suite with isolated version state and restart replay', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(readFileSync(new URL('../src/simulator/migrations/001_calendar.sql', import.meta.url), 'utf8'));
    await pg.exec(readFileSync(new URL('../src/evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
    const db: TransactionalDatabase & AgentTransactionalSql = { query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params),
      transaction: fn => pg.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })) };
    const simulator = new CalendarSimulator(new PostgresCalendarStore(db));
    const cases = calendarAcceptanceScenarios();
    const suite = freezeCalendarSuite({ jobId: '38bc4f0d-6546-43ae-ae35-2c8a89230af8', origin: 'internal_fixture', frozenAt: '2026-11-07T20:00:00Z', review: { reviewerId: 'local-fixture-review', approved: true },
      scenarios: cases.map(({ id, prompt, actorId, seed, checks }) => structuredClone({ id, prompt, actorId, seed, checks })) });
    const execute = vi.fn(async ({ version }: { operationId: string; version: string }) => ({ kind: 'calendar' as const, suite,
      run: await runCalendarSuite({ suite, branchId: 'local-branch', versionLabel: version, dependencies: { simulator, db,
        targetForScenario: s => ({ complete: async messages => version === 'broken' || messages.some(m => m.role === 'tool')
          ? { role: 'assistant' as const, content: 'Local sequence complete.' }
          : { role: 'assistant' as const, content: null, tool_calls: structuredClone(cases.find(c => c.id === s.id)!.referenceCalls) } }) } }),
      investigation: { findings: [], label: 'local fixture only' }, limitations: ['Local fixture only.'], costs: [], unknownCosts: ['Provider not called; hosting unknown.'] }));
    const adapter: RichEvaluationAdapter = { getSuite: async () => suite, execute };
    const resolve = async () => ({ tenantId: 'fixture-tenant', jobId: suite.jobId, environment: 'test' as const, isFixture: true, suite, scenarioIds: suite.scenarios.map(s => s.id),
      baseline: { version: 'fixed', targetId: 'local-fixed', branchId: 'local-branch', adapter }, current: { version: 'broken', targetId: 'local-broken', branchId: 'local-branch', adapter } });
    const ctx = { jobId: suite.jobId, environment: 'test' as const, budgetMicroUsd: 0, recordCost: async () => {}, recordProgress: async () => {} };
    const request = { operationId: 'calendar-fixture', baselineVersion: 'fixed', currentVersion: 'broken', mode: 'comparison' as const };
    const service = createComparisonMonitoringService({ checkpoints: new PostgresTextCheckpointStore(db), resolve });
    const result = await service.compare(ctx, request);
    expect(result.comparison.baselineCounts.passed).toBe(12);
    expect(result.comparison.regressions.length).toBeGreaterThan(0);
    expect(result.comparison.passRateDelta).toBeLessThan(0);
    expect(result.calendarDifferences).not.toBeNull();
    expect(result.baseline.artifact.run.runId).not.toBe(result.current.artifact.run.runId);
    const replay = await createComparisonMonitoringService({ checkpoints: new PostgresTextCheckpointStore(db), resolve }).compare(ctx, request);
    expect(replay).toEqual(result); expect(execute).toHaveBeenCalledTimes(2);
  } finally { await pg.close(); }
}, 30_000);

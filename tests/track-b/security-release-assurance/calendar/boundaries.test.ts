/** Offline composed-boundary tests; actual workflow, SQL grades and checkpoint SQL. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CalendarSimulator, calendarSeed } from '../src/simulator/calendar';
import { PostgresCalendarStore, type TransactionalDatabase } from '../src/simulator/postgres';
import { freezeCalendarSuite, runCalendarSuite } from '../src/simulator/workflow';
import { canonicalJson } from '../src/evals/text';
import { PostgresTextCheckpointStore } from '../src/evals/integration/checkpoints';
import { createComparisonMonitoringService, createRetainedComparisonAdapter, richChecks, type RichEvaluationAdapter, type RichRunArtifact } from '../src/monitoring';

type CalendarArtifact = Extract<RichRunArtifact, { kind: 'calendar' }>;
const digest = (a: RichRunArtifact) => createHash('sha256').update(canonicalJson(a)).digest('hex');
const suite = freezeCalendarSuite({ jobId: 'calendar-security-fixture', origin: 'internal_fixture', frozenAt: '2026-11-07T20:00:00Z', review: { approved: true, reviewerId: 'offline-reviewer' },
  scenarios: Array.from({ length: 12 }, (_, i) => ({ id: `case-${i}`, prompt: 'Read the calendar; local fixture only.', actorId: 'alice', seed: calendarSeed(),
    checks: [{ kind: 'count' as const, calendarId: 'personal', status: 'active' as const, expected: i === 1 ? 2 : 1 }],
    claimRequiredState: [{ kind: 'event' as const, event: { ...calendarSeed().events[0], id: i === 6 ? 'sql-fault' : i === 2 || i === 3 ? 'missing-event' : 'existing' } }],
  })) });
const ctx = { jobId: suite.jobId, environment: 'test' as const, budgetMicroUsd: 0, recordCost: async () => {}, recordProgress: async () => {} };
const request = { operationId: 'tick', baselineVersion: 'v1', currentVersion: 'v2', mode: 'monitoring' as const };
const artifacts: CalendarArtifact[] = [];
async function database() {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL('../src/simulator/migrations/001_calendar.sql', import.meta.url), 'utf8'));
  await pg.exec(readFileSync(new URL('../src/evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
  const db: TransactionalDatabase = { query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params), transaction: fn => pg.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })) };
  return { pg, db };
}
beforeAll(async () => {
  const { pg, db } = await database();
  try {
    const gradingDb: TransactionalDatabase = { query: db.query, transaction: fn => db.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => {
      if (sql.includes('FROM sim_events') && params?.[3] === 'sql-fault') throw new Error('local claim-grade SQL outage');
      return tx.query<T>(sql, params);
    } })) };
    for (const versionLabel of ['v1', 'v2']) {
      const store = new PostgresCalendarStore(db);
      const snapshot = store.snapshot.bind(store);
      let snapshotOutage = false;
      store.snapshot = async scope => { if (snapshotOutage) { snapshotOutage = false; throw new Error('local snapshot outage'); } return snapshot(scope); };
      const run = await runCalendarSuite({ suite, branchId: 'fixture-branch', versionLabel, dependencies: {
        simulator: new CalendarSimulator(store), db: gradingDb,
        targetForScenario: s => {
          if (s.id === 'case-5') throw new Error('local initialization outage');
          if (s.id === 'case-8') snapshotOutage = true;
          return { complete: async () => { if (s.id === 'case-4') throw new Error('local target outage'); return { role: 'assistant' as const, content: s.id === 'case-7' ? ' ' : 'Local fixture complete.' }; } };
        },
        classifySuccess: async (_e, s) => s.id === 'case-2' ? 'no_success' : s.id === 'case-3' || s.id === 'case-7' ? 'success' : 'unknown',
      } });
      artifacts.push({ kind: 'calendar', suite, run, investigation: { fixture: true }, limitations: ['Local deterministic SQL fixture.'], costs: [], unknownCosts: ['No providers called.'] });
    }
  } finally { await pg.close(); }
}, 30_000);
async function composed(adapter: RichEvaluationAdapter, body: (h: { compare: (operationId?: string) => ReturnType<ReturnType<typeof createComparisonMonitoringService>['compare']>; current: ReturnType<typeof vi.fn>; pg: PGlite }) => Promise<void>) {
  const { pg, db } = await database();
  const current = vi.fn(async () => structuredClone(artifacts[1]));
  try {
    const service = createComparisonMonitoringService({ checkpoints: new PostgresTextCheckpointStore(db), resolve: async () => ({ tenantId: 'fixture-tenant', jobId: suite.jobId, environment: 'test', isFixture: true, suite, scenarioIds: suite.scenarios.map(s => s.id),
      baseline: { version: 'v1', targetId: 'fixture-v1', branchId: 'fixture-branch', adapter },
      current: { version: 'v2', targetId: 'fixture-v2', branchId: 'fixture-branch', adapter: { getSuite: async () => suite, execute: current } } }) });
    await body({ compare: (operationId = 'tick') => service.compare(ctx, { ...request, operationId }), current, pg });
  } finally { await pg.close(); }
}
type MutableAdapter = { -readonly [K in keyof RichEvaluationAdapter]: RichEvaluationAdapter[K] };
function custom(a = structuredClone(artifacts[0])): MutableAdapter {
  return { readOnly: true, retainedIdentity: { runId: a.run.runId, digest: digest(a) }, getSuite: async () => suite, execute: vi.fn(async () => structuredClone(a)) };
}

describe('Acceptance: real partial infrastructure and unknown claims compose', () => {
  it('preserves state mismatch before unknown-claim uncertainty and distinguishes false success', () => {
    const checks = richChecks(artifacts[0]);
    expect(checks.slice(0, 4).map(c => c.outcome)).toEqual(['inconclusive', 'failed', 'passed', 'failed']);
    expect(artifacts[0].run.results.slice(0, 4).map(r => r.reason)).toEqual(['claim_not_assessed', 'state_mismatch', 'sql_checks_passed', 'false_success']);
    expect(artifacts[0].run.results[2].claimGrade!.passed).toBe(false);
  });
  it('accepts target and setup outages with partial evidence without inventing SQL grades', () => {
    const r = artifacts[0].run.results;
    expect(r[4].execution!.stopped).toBe('target_error'); expect(r[4].stateGrade).toBeUndefined();
    expect(r[5].execution).toBeUndefined(); expect(r[5].partialState).toBeUndefined();
    expect(r[8].execution).toBeUndefined(); expect(r[8].partialState).toEqual(calendarSeed());
    expect(richChecks(artifacts[0]).slice(4, 6).map(c => c.outcome)).toEqual(['infrastructure_error', 'infrastructure_error']);
  });
  it('accepts an outage after state SQL succeeds but claim SQL fails, retaining only execution', () => {
    const r = artifacts[0].run.results[6];
    expect(r.execution!.stopped).toBe('complete'); expect(r.stateGrade).toBeUndefined(); expect(r.claimGrade).toBeUndefined();
    expect(r.reason).toBe('sql_grading_unavailable'); expect(richChecks(artifacts[0])[6].outcome).toBe('infrastructure_error');
  });
  it('turns a positive classifier with blank assistant evidence into an unknown claim', () => {
    const r = artifacts[0].run.results[7]; expect(r.claim).toBe('unknown'); expect(r.claimGrade!.passed).toBe(true);
    expect(richChecks(artifacts[0])[7].outcome).toBe('inconclusive');
  });
  it('composes retained mixed outcomes through SQL checkpoints and replays without dispatch', async () => {
    const adapter = custom();
    await composed(adapter, async ({ compare, current }) => {
      const first = await compare(); const second = await compare();
      expect(second).toEqual(first); expect(current).toHaveBeenCalledTimes(1); expect(adapter.execute).toHaveBeenCalledTimes(1);
      expect(first.comparison.pairedAssessed).toBe(3); expect(first.comparison.unresolved).toHaveLength(9);
      expect(first.comparison.regressions).toHaveLength(0); expect(first.comparison.passRateDelta).toBe(0);
      expect(first.alertDraft!.subject).toContain('9 unresolved'); expect(first.calendarDifferences).not.toBeNull();
    });
  });
  it('retained factory snapshots caller changes and detaches returned evidence', async () => {
    const a = structuredClone(artifacts[0]); const adapter = createRetainedComparisonAdapter(a); const expected = digest(a);
    a.limitations.push('caller edit');
    const read = await adapter.execute({ operationId: 'ignored', version: 'v1' }); read.limitations.push('returned edit');
    const again = await adapter.execute({ operationId: 'ignored', version: 'v1' });
    expect(digest(again)).toBe(expected); expect(adapter.retainedIdentity!.digest).toBe(expected);
  });
});

describe('Acceptance: custom retained adapter contract fails closed', () => {
  it.each(['missing', 'uppercase', 'extra-field'] as const)('rejects %s identity before either dispatch', async kind => {
    const adapter = custom();
    if (kind === 'missing') delete adapter.retainedIdentity;
    if (kind === 'uppercase') adapter.retainedIdentity = { ...adapter.retainedIdentity!, digest: 'A'.repeat(64) };
    if (kind === 'extra-field') adapter.retainedIdentity = { ...adapter.retainedIdentity!, extra: true } as typeof adapter.retainedIdentity;
    await composed(adapter, async ({ compare, current, pg }) => {
      await expect(compare()).rejects.toMatchObject({ code: 'rejected_input' });
      expect(adapter.execute).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
      expect((await pg.query('SELECT * FROM text_integration.checkpoints')).rows).toHaveLength(0);
    });
  });
  it.each(['content', 'run-id'] as const)('fences %s mismatch after retained read, blocks current and redispatch', async kind => {
    const adapter = custom(); const altered = structuredClone(artifacts[0]);
    if (kind === 'content') altered.investigation = { altered: true }; else altered.run.runId = 'changed-run';
    adapter.execute = vi.fn(async () => altered);
    await composed(adapter, async ({ compare, current, pg }) => {
      await expect(compare()).rejects.toMatchObject({ code: 'needs_operator' });
      await expect(compare()).rejects.toMatchObject({ code: 'needs_operator' });
      expect(adapter.execute).toHaveBeenCalledTimes(1); expect(current).not.toHaveBeenCalled();
      expect((await pg.query('SELECT state FROM text_integration.checkpoints WHERE kind=$1', ['rich_comparison_baseline'])).rows).toEqual([{ state: 'ambiguous' }]);
    });
  });
  it.each(['partial-promoted', 'unknown-promoted', 'missing-claim-grade'] as const)('rejects %s even when retained digest matches malformed evidence', async kind => {
    const a = structuredClone(artifacts[0]);
    if (kind === 'partial-promoted') { a.run.results[6].outcome = 'passed'; a.run.results[6].reason = 'sql_checks_passed'; }
    if (kind === 'unknown-promoted') { a.run.results[0].outcome = 'passed'; a.run.results[0].reason = 'sql_checks_passed'; }
    if (kind === 'missing-claim-grade') delete a.run.results[0].claimGrade;
    await composed(custom(a), async ({ compare, current }) => {
      await expect(compare()).rejects.toMatchObject({ code: 'needs_operator' }); expect(current).not.toHaveBeenCalled();
    });
  });
});

describe('Regression: custom adapter identity is pinned before retained read', () => {
  it('accepts evidence matching a replacement identity rather than the identity committed before execution', async () => {
    const adapter = custom(); const original = structuredClone(adapter.retainedIdentity!);
    const replacement = structuredClone(artifacts[0]); replacement.investigation = { substituted: true };
    adapter.execute = async () => { adapter.retainedIdentity = { runId: replacement.run.runId, digest: digest(replacement) }; return replacement; };
    await composed(adapter, async ({ compare, current, pg }) => {
      await expect(compare()).rejects.toMatchObject({ code: 'needs_operator' });
      expect(current).not.toHaveBeenCalled();
      const rows = await pg.query<{ value: { baseline: { retainedIdentity: typeof original } } }>('SELECT value FROM text_integration.checkpoints WHERE kind=$1', ['rich_comparison_identity']);
      expect(rows.rows[0].value.baseline.retainedIdentity).toEqual(original);
      await expect(compare()).rejects.toThrow(); // Later replay detects drift, but first result already escaped.
    });
  });
});

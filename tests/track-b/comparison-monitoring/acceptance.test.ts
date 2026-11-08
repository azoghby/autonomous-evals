/** Local internal fixtures only. No endpoints, provider calls, email, or customer evidence. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { freezeSuite } from '../src/evals/text/freeze';
import type { FrozenTextSuite, SuiteRun, CheckStatus } from '../src/evals/text/schema';
import { PostgresTextCheckpointStore } from '../src/evals/integration/checkpoints';
import type { AgentTransactionalSql } from '../src/agents/postgres-ports';
import type { RichEvaluationAdapter } from '../src/monitoring';
import { compareRichChecks, createRetainedComparisonAdapter, createComparisonMonitoringService } from '../src/monitoring';

const suite: FrozenTextSuite = freezeSuite({ schemaVersion: 'text_suite.v1', jobId: 'local-fixture', versionLabel: 'reviewed', frozenAt: '2026-11-07T20:00:00Z', systemPrompt: null, referenceText: null,
  review: { sessions: [], rejections: [], reductions: [] },
  scenarios: Array.from({ length: 12 }, (_, i) => { const id = `S${String(i + 1).padStart(2, '0')}`; return {
    id, title: `Local fixture ${i}`, category: i < 4 ? 'ordinary' as const : i < 8 ? 'instruction_edge' as const : 'grounding_ambiguity' as const,
    userMessage: 'The response must contain the literal "READY".', rationale: 'Local explicit constraint fixture.', severity: 'low' as const,
    objectiveChecks: [{ id: `${id}.o1`, kind: 'objective' as const, description: 'Required marker', spec: { type: 'contains' as const, value: 'READY', case_sensitive: true } }],
    rubricChecks: [{ id: `${id}.r1`, kind: 'rubric' as const, description: 'Factual assessment', rubric: 'Judge correctness against reference.', assessesFactualCorrectness: true, requiresReference: true as const }],
  }; }),
});
const request = { operationId: 'local-operation', baselineVersion: 'v1', currentVersion: 'v2', mode: 'comparison' as const };
const ctx = { jobId: suite.jobId, environment: 'test' as const, budgetMicroUsd: 1000, recordCost: vi.fn(async () => {}), recordProgress: vi.fn(async () => {}) };
function artifact(version: string, operationId: string) {
  const statuses: CheckStatus[] = version === 'v1' ? ['pass', 'fail', 'pass', 'pass', 'pass'] : ['fail', 'pass', 'inconclusive', 'error', 'pass'];
  const run: SuiteRun = { schemaVersion: 'text_run.v1', jobId: suite.jobId, suiteDigest: suite.digest, versionLabel: suite.versionLabel, runId: operationId,
    startedAt: '2026-11-07T20:00:00Z', completedAt: '2026-11-07T20:00:01Z', executions: suite.scenarios.map((s, i) => ({
      scenarioId: s.id, runId: operationId, attempt: 'initial', outcome: i === 4 && version === 'v2' ? 'infrastructure_error' : 'completed',
      target: { ok: !(i === 4 && version === 'v2'), errorCode: i === 4 && version === 'v2' ? 'timeout' : null, latencyMs: 1 },
      responseText: 'READY', responseClipped: false, startedAt: '2026-11-07T20:00:00Z', completedAt: '2026-11-07T20:00:01Z',
      checks: [{ checkId: `${s.id}.o1`, kind: 'objective', status: statuses[i] ?? 'pass', detail: 'Local fixture result.', evidenceQuotes: ['READY'], reason: i === 2 && version === 'v2' ? 'judge_unavailable' : i === 3 && version === 'v2' ? 'check_error' : null },
        { checkId: `${s.id}.r1`, kind: 'rubric', status: 'not_assessed', detail: 'No reference.', evidenceQuotes: [], reason: 'no_reference' }],
    })) };
  return { kind: 'text' as const, suite, run, investigation: { findings: [], fixtureLabel: 'local-only' }, limitations: ['Local fixture evidence only.'],
    costs: [{ id: `local-${version}`, source: 'fixture-measured', microUsd: version === 'v1' ? 7 : 11, measured: true as const }], unknownCosts: ['customer provider usage unknown', 'hosting unknown'] };
}
async function database(path?: string) {
  const engine = new PGlite(path);
  await engine.exec(readFileSync(new URL('../src/evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
  const db: AgentTransactionalSql = { query: <T>(sql: string, params?: unknown[]) => engine.query<T>(sql, params), transaction: fn => engine.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })) };
  return { engine, checkpoints: new PostgresTextCheckpointStore(db) };
}
function fixture(checkpoints: PostgresTextCheckpointStore) {
  const before = vi.fn(async ({ operationId, version }: { operationId: string; version: string }) => artifact(version, operationId));
  const after = vi.fn(async ({ operationId, version }: { operationId: string; version: string }) => artifact(version, operationId));
  const authorized = { tenantId: 'local-tenant', jobId: suite.jobId, environment: 'test' as const, isFixture: true, suite,
    scenarioIds: suite.scenarios.map(s => s.id), baseline: { version: 'v1', targetId: 'local-target-v1', branchId: null, adapter: { getSuite: async () => suite, execute: before } as RichEvaluationAdapter },
    current: { version: 'v2', targetId: 'local-target-v2', branchId: null, adapter: { getSuite: async () => suite, execute: after } as RichEvaluationAdapter } };
  const resolve = vi.fn(async () => authorized);
  return { authorized, before, after, resolve, service: createComparisonMonitoringService({ checkpoints, resolve }) };
}

describe('Track B rich composition acceptance — local fixtures and real PostgreSQL storage', () => {
  it('retains rich outcomes, measured and unknown costs, paired arithmetic, grounded alert and immutable baseline', async () => {
    const db = await database();
    try {
      const f = fixture(db.checkpoints);
      const result = await f.service.compare(ctx, request);
      expect(result.baseline.artifact.run.runId).not.toBe(result.current.artifact.run.runId);
      expect(result.comparison.regressions).toHaveLength(1);
      expect(result.comparison.improvements).toHaveLength(1);
      expect(result.comparison.totalChecks).toBe(24);
      expect(result.comparison.interpretation).toBe('observed_changes_only');
      expect(result.current.checks.map(c => c.outcome)).toEqual(expect.arrayContaining(['failed', 'passed', 'not_assessed', 'inconclusive', 'check_error', 'infrastructure_error']));
      expect(result.costs.knownMicroUsd).toBe(18);
      expect(result.costs.unknown.length).toBeGreaterThan(0);
      expect(result.alertDraft).toBeNull();
      expect(result.comparison.pairedAssessed).toBe(9);
      expect(result.comparison.passRateDelta).toBe(0);
      expect(result.baseline.artifact.investigation).toEqual({ findings: [], fixtureLabel: 'local-only' });
      expect(f.before).toHaveBeenCalledTimes(1); expect(f.after).toHaveBeenCalledTimes(1);
      expect(ctx.recordCost).not.toHaveBeenCalled();
    } finally { await db.engine.close(); }
  });
  it('reopens disk PostgreSQL and replays complete results without a second execution', async () => {
    const path = await mkdtemp(join(tmpdir(), 'comparison-durable-local-'));
    let first = await database(path);
    try {
      const f = fixture(first.checkpoints); const expected = await f.service.compare(ctx, request);
      await first.engine.close(); first = await database(path);
      const restarted = fixture(first.checkpoints);
      expect(await restarted.service.compare(ctx, request)).toEqual(expected);
      expect(restarted.before).not.toHaveBeenCalled(); expect(restarted.after).not.toHaveBeenCalled();
    } finally { await first.engine.close(); await rm(path, { recursive: true, force: true }); }
  }, 30_000);
  it.each(['job', 'tenant', 'target', 'appended_inventory', 'changed_suite'] as const)('rejects %s conflicts before dispatch/replay', async change => {
    const db = await database();
    try {
      const f = fixture(db.checkpoints);
      if (change === 'job') f.authorized.jobId = 'another-job';
      if (change === 'tenant' || change === 'target') {
        await f.service.compare(ctx, request); f.before.mockClear(); f.after.mockClear();
        if (change === 'tenant') f.authorized.tenantId = 'another-tenant'; else f.authorized.current.targetId = 'another-target';
      }
      if (change === 'appended_inventory') f.authorized.scenarioIds.push('track-a-red-team');
      if (change === 'changed_suite') f.authorized.current.adapter.getSuite = async () => ({ ...suite, frozenAt: '2026-11-08T20:00:00Z' });
      await expect(f.service.compare(ctx, request)).rejects.toThrow();
      expect(f.before).not.toHaveBeenCalled(); expect(f.after).not.toHaveBeenCalled();
    } finally { await db.engine.close(); }
  });
  it('persists ambiguous dispatch and never automatically retries either version', async () => {
    const db = await database();
    try {
      const f = fixture(db.checkpoints); f.after.mockImplementation(async () => { throw new Error('local response lost'); });
      await expect(f.service.compare(ctx, request)).rejects.toThrow();
      const restart = createComparisonMonitoringService({ checkpoints: db.checkpoints, resolve: f.resolve });
      await expect(restart.compare(ctx, request)).rejects.toThrow();
      expect(f.before).toHaveBeenCalledTimes(1); expect(f.after).toHaveBeenCalledTimes(1);
    } finally { await db.engine.close(); }
  });

});


describe('paired comparison arithmetic and monitor-only alert drafts', () => {
  it('uses only paired definite observations and retains rubric concern/unassessed separately', () => {
    const check = (n: number, outcome: 'passed' | 'failed' | 'not_assessed' | 'rubric_concern') => ({ scenarioId: `S${n}`, checkId: `c${n}`, outcome, evidenceIds: [`local-evidence-${n}`] });
    const result = compareRichChecks([check(1, 'passed'), check(2, 'passed'), check(3, 'failed'), check(4, 'not_assessed')],
      [check(1, 'failed'), check(2, 'passed'), check(3, 'rubric_concern'), check(4, 'not_assessed')]);
    expect(result.pairedAssessed).toBe(2); expect(result.passRateDelta).toBe(-0.5);
    expect(result.currentCounts.rubric_concern).toBe(1); expect(result.currentCounts.not_assessed).toBe(1);
    expect(result.unresolved).toHaveLength(2); expect(result.regressions).toHaveLength(1);
    expect(compareRichChecks([check(1, 'not_assessed')], [check(1, 'rubric_concern')]).passRateDelta).toBeNull();
  });
  it('drafts a monitoring alert for observed changes while never sending a message', async () => {
    const db = await database();
    try {
      const f = fixture(db.checkpoints);
      const original = artifact('v1', 'retained-local-baseline');
      f.authorized.baseline.adapter = createRetainedComparisonAdapter(original);
      const result = await f.service.compare(ctx, { ...request, mode: 'monitoring' });
      expect(result.baseline.artifact.run.runId).toBe('retained-local-baseline');
      expect(result.alertDraft?.subject).toContain('1 observed regressions');
      expect(result.alertDraft?.text).toContain('statistical significance is not assessed');
      expect(result.comparison.unresolved).toHaveLength(15);
      expect(f.before).not.toHaveBeenCalled(); expect(f.after).toHaveBeenCalledTimes(1);
    } finally { await db.engine.close(); }
  });
  it('rejects a monitor with a dispatching baseline before either call', async () => {
    const db = await database();
    try { const f = fixture(db.checkpoints);
      await expect(f.service.compare(ctx, { ...request, mode: 'monitoring' })).rejects.toThrow();
      expect(f.before).not.toHaveBeenCalled(); expect(f.after).not.toHaveBeenCalled();
    } finally { await db.engine.close(); }
  });
});

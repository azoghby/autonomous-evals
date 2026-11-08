/** Independent offline review fixtures; no target/provider/network/message ports. */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { freezeSuite } from '../src/evals/text/freeze';
import type { SuiteRun } from '../src/evals/text/schema';
import type { AgentTransactionalSql } from '../src/agents/postgres-ports';
import { PostgresTextCheckpointStore } from '../src/evals/integration/checkpoints';
import type { TextCheckpointStore } from '../src/evals/integration/checkpoints';
import { createComparisonMonitoringService, createRetainedComparisonAdapter } from '../src/monitoring';
import type { AuthorizedComparison, RichRunArtifact } from '../src/monitoring';

const suite = freezeSuite({ schemaVersion: 'text_suite.v1', jobId: 'persistence-review-fixture', versionLabel: 'frozen-prompt', frozenAt: '2026-11-07T00:00:00Z', systemPrompt: null, referenceText: null,
  review: { sessions: [], rejections: [], reductions: [] }, scenarios: Array.from({ length: 12 }, (_, i) => {
    const id = `S${String(i + 1).padStart(2, '0')}`;
    return { id, title: 'Offline persistence fixture', category: i < 4 ? 'ordinary' as const : i < 8 ? 'instruction_edge' as const : 'grounding_ambiguity' as const,
      userMessage: 'The response must contain the literal "READY".', rationale: 'Explicit fixture constraint.', severity: 'low' as const,
      objectiveChecks: [{ id: `${id}.o1`, kind: 'objective' as const, description: 'Contains marker', spec: { type: 'contains' as const, value: 'READY', case_sensitive: true } }], rubricChecks: [] };
  }) });
const ctx = { jobId: suite.jobId, environment: 'test' as const, budgetMicroUsd: 100, recordCost: vi.fn(async () => {}), recordProgress: vi.fn(async () => {}) };
const request = { operationId: 'review-tick', baselineVersion: 'v1', currentVersion: 'v2', mode: 'monitoring' as const };
function artifact(runId: string, failed = false): RichRunArtifact {
  const run: SuiteRun = { schemaVersion: 'text_run.v1', jobId: suite.jobId, suiteDigest: suite.digest, versionLabel: suite.versionLabel, runId,
    startedAt: '2026-11-07T00:00:00Z', completedAt: '2026-11-07T00:00:01Z', executions: suite.scenarios.map(s => ({
      scenarioId: s.id, runId, attempt: 'initial', outcome: 'completed', target: { ok: true, errorCode: null, latencyMs: 1 },
      responseText: failed ? 'EMPTY' : 'READY', responseClipped: false, startedAt: '2026-11-07T00:00:00Z', completedAt: '2026-11-07T00:00:01Z',
      checks: [{ checkId: `${s.id}.o1`, kind: 'objective', status: failed ? 'fail' : 'pass', detail: 'Explicit fixture check', evidenceQuotes: [], reason: null }],
    })) };
  return { kind: 'text', suite, run, investigation: { findings: [] }, limitations: ['Offline fixture'], costs: [], unknownCosts: ['Fixture costs unmeasured'] };
}
async function open(path: string) {
  const engine = new PGlite(path);
  await engine.exec(readFileSync(new URL('../src/evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
  const db: AgentTransactionalSql = { query: <T>(sql: string, params?: unknown[]) => engine.query<T>(sql, params), transaction: fn => engine.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })) };
  return { engine, checkpoints: new PostgresTextCheckpointStore(db) };
}
function binding(checkpoints: TextCheckpointStore) {
  const current = vi.fn(async ({ operationId }: { operationId: string }) => artifact(operationId, true));
  const authorized: AuthorizedComparison = { tenantId: 'fixture-tenant', jobId: suite.jobId, environment: 'test', isFixture: true, suite, scenarioIds: suite.scenarios.map(s => s.id),
    baseline: { version: 'v1', targetId: 'target-v1', branchId: null, adapter: createRetainedComparisonAdapter(artifact('original-baseline')) },
    current: { version: 'v2', targetId: 'target-v2', branchId: null, adapter: { getSuite: async () => suite, execute: current } } };
  const resolve = vi.fn(async () => authorized);
  return { current, authorized, resolve, service: createComparisonMonitoringService({ checkpoints, resolve }) };
}
async function disk<T>(fn: (path: string) => Promise<T>) {
  const path = await mkdtemp(join(tmpdir(), 'monitoring-review-disk-'));
  try { return await fn(path); } finally { await rm(path, { recursive: true, force: true }); }
}

describe('persistence acceptance: actual disk SQL checkpoint adapter', () => {
  it('retains committed current artifact after lost completion acknowledgement and close/reopen', async () => disk(async path => {
    let db = await open(path);
    const real = db.checkpoints;
    const ports: TextCheckpointStore = { claim: k => real.claim(k), get: k => real.get(k), release: (k, t) => real.release(k, t), markAmbiguous: (k, t) => real.markAmbiguous(k, t),
      complete: async (k, token, value) => { await real.complete(k, token, value); if (k.kind === 'rich_comparison_current') throw new Error('fixture lost SQL ACK'); } };
    const first = binding(ports);
    await expect(first.service.compare(ctx, request)).rejects.toThrow();
    expect(first.current).toHaveBeenCalledTimes(1);
    const rows = await db.engine.query<{ kind: string; state: string }>('SELECT kind, state FROM text_integration.checkpoints ORDER BY kind');
    expect(rows.rows).toHaveLength(3); expect(rows.rows.every(r => r.state === 'completed')).toBe(true);
    await db.engine.close(); db = await open(path);
    try {
      const replay = binding(db.checkpoints);
      const result = await replay.service.compare(ctx, request);
      expect(result.comparison.regressions).toHaveLength(12);
      expect(result.costs.knownMicroUsd).toBe(0); expect(result.costs.unknown).toContain('Fixture costs unmeasured');
      expect(replay.current).not.toHaveBeenCalled(); expect(replay.resolve).toHaveBeenCalledTimes(1);
    } finally { await db.engine.close(); }
  }), 30_000);

  it('fences ambiguous current dispatch across close/reopen while retaining completed baseline', async () => disk(async path => {
    let db = await open(path);
    const first = binding(db.checkpoints);
    first.current.mockImplementation(async () => { throw new Error('fixture target outcome unknown'); });
    await expect(first.service.compare(ctx, request)).rejects.toThrow();
    const rows = await db.engine.query<{ kind: string; state: string }>('SELECT kind, state FROM text_integration.checkpoints');
    expect(rows.rows).toContainEqual({ kind: 'rich_comparison_baseline', state: 'completed' });
    expect(rows.rows).toContainEqual({ kind: 'rich_comparison_current', state: 'ambiguous' });
    await db.engine.close(); db = await open(path);
    try { const replay = binding(db.checkpoints); await expect(replay.service.compare(ctx, request)).rejects.toThrow(); expect(replay.current).not.toHaveBeenCalled(); }
    finally { await db.engine.close(); }
  }), 30_000);
});

describe('Regression: immutable retained-baseline authority', () => {
  it.each(['replacement-baseline', 'original-baseline'])('rejects changed retained artifact %s under the same operation identity', async replacementId => disk(async path => {
    let db = await open(path);
    const first = binding(db.checkpoints); await first.service.compare(ctx, request);
    await db.engine.close(); db = await open(path);
    try {
      const changed = binding(db.checkpoints);
      changed.authorized.baseline.adapter = createRetainedComparisonAdapter(artifact(replacementId, true));
      await expect(changed.service.compare(ctx, request)).rejects.toThrow();
      expect(changed.current).not.toHaveBeenCalled();
      // A fresh tick uses the replacement and observes zero regressions; same authority, different result.
      const next = await changed.service.compare(ctx, { ...request, operationId: 'review-next-tick' });
      expect(next.baseline.artifact.run.runId).toBe(replacementId);
      expect(next.comparison.regressions).toHaveLength(0);
    } finally { await db.engine.close(); }
  }), 30_000);
});

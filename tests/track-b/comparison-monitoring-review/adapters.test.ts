/** Explicit local fixture: real text service, SQL checkpoints and wrapper; no external I/O. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { canonicalJson } from '../src/evals/text';
import { makeSuite } from '../src/evals/text/__tests__/fixtures';
import { PostgresTextCheckpointStore } from '../src/evals/integration/checkpoints';
import { createTextEvaluationServices } from '../src/evals/integration/services';
import { createComparisonMonitoringService, createTextComparisonAdapter } from '../src/monitoring';
import type { AgentTransactionalSql } from '../src/agents/postgres-ports';

it('Acceptance: production text wrapper preserves cost unknowns, replays and fences an ambiguous target result', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(readFileSync(new URL('../src/evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
    const db: AgentTransactionalSql = { query: <T>(sql: string, params?: unknown[]) => pg.query<T>(sql, params),
      transaction: fn => pg.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })) };
    const checkpoints = new PostgresTextCheckpointStore(db);
    const suite = makeSuite();
    const job = { jobId: suite.jobId, customerId: 'local-review', environment: 'test' as const, package: 'text_eval' as const, isFixture: true, quoteVersion: null, linkedRetestOf: null };
    const key = { jobId: suite.jobId, kind: 'suite', id: suite.digest,
      inputDigest: createHash('sha256').update(canonicalJson({ environment: 'test', input: suite.digest })).digest('hex') };
    const claim = await checkpoints.claim(key);
    if (claim.state !== 'claimed') throw new Error('fixture initialization');
    await checkpoints.complete(key, claim.token, suite);
    const ctx = { jobId: suite.jobId, environment: 'test' as const, budgetMicroUsd: 0, recordCost: vi.fn(async () => {}), recordProgress: vi.fn(async () => {}) };
    const runner = { run: vi.fn(async () => { throw new Error('No agent call authorized by fixture'); }) };
    const before = vi.fn(async () => ({ ok: true as const, text: 'READY', latencyMs: 1 }));
    let timeout = false;
    const after = vi.fn(async () => timeout ? ({ ok: false as const, errorCode: 'timeout', message: 'Local synthetic timeout', latencyMs: 1 }) : ({ ok: true as const, text: 'READY', latencyMs: 1 }));
    const readCosts = vi.fn(async () => ({ costs: [], unknownCosts: ['Target usage unknown; fixture has no billable provider.'] }));
    const bindings = [before, after].map((send, i) => ({ version: `v${i + 1}`, targetId: `fixture-target-${i}`, branchId: null,
      adapter: createTextComparisonAdapter({ ctx, suiteDigest: suite.digest, readCosts,
        services: createTextEvaluationServices({ runner, checkpoints, resolve: async () => ({ job, targetVersion: `v${i + 1}`, target: { send }, judge: null }) }) }) }));
    const service = createComparisonMonitoringService({ checkpoints, resolve: async () => ({ tenantId: 'local-tenant', jobId: job.jobId, environment: 'test', isFixture: true, suite,
      scenarioIds: suite.scenarios.map(s => s.id), baseline: bindings[0], current: bindings[1] }) });
    const request = { operationId: 'wrapper-review', baselineVersion: 'v1', currentVersion: 'v2', mode: 'comparison' as const };
    const result = await service.compare(ctx, request);
    expect(result.comparison.baselineCounts.passed).toBe(12);
    expect(result.comparison.currentCounts.passed).toBe(12);
    expect(result.comparison.regressions).toHaveLength(0);
    expect(result.comparison.pairedAssessed).toBe(12);
    expect(result.comparison.passRateDelta).toBe(0);
    expect(result.comparison.unresolved).toHaveLength(0);
    expect(result.costs.knownMicroUsd).toBe(0);
    expect(result.costs.unknown.join(' ')).toContain('Target usage unknown');
    expect(result.current.artifact.limitations.join(' ')).toContain('unknown');
    expect(await service.compare(ctx, request)).toEqual(result);
    expect(before).toHaveBeenCalledTimes(12); expect(after).toHaveBeenCalledTimes(12);
    expect(readCosts).toHaveBeenCalledTimes(2); expect(runner.run).not.toHaveBeenCalled();
    expect(ctx.recordCost).not.toHaveBeenCalled();
    // Actual durable service treats an unsuccessful target transport as ambiguous;
    // it must not manufacture a clean report or redispatch it on replay.
    timeout = true;
    const failedRequest = { ...request, operationId: 'wrapper-ambiguous' };
    await expect(service.compare(ctx, failedRequest)).rejects.toMatchObject({ code: 'needs_operator' });
    await expect(service.compare(ctx, failedRequest)).rejects.toMatchObject({ code: 'needs_operator' });
    expect(after).toHaveBeenCalledTimes(13); expect(readCosts).toHaveBeenCalledTimes(3);
  } finally { await pg.close(); }
}, 30_000);

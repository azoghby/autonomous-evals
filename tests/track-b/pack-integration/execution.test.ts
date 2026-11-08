import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { RED_TEAM_LIBRARY } from '../../../packages/core/src/redteam/library';
import { makeSuite } from '../../../packages/core/src/evals/text/__tests__/fixtures';
import { executeSuite } from '../../../packages/core/src/evals/text/execute';
import { evaluateObjectiveCheck } from '../../../packages/core/src/evals/text/objective';
import { PostgresTextCheckpointStore } from '../../../packages/core/src/evals/integration/checkpoints';
import type { AgentTransactionalSql } from '../../../packages/core/src/agents/postgres-ports';
import { createTrustedRegistry } from '../../../packages/core/src/evals/packs/trusted';
import { freezePack, packReviewDigest } from '../../../packages/core/src/evals/packs/contract';
import { createPackExecutionService, comparePackRuns, type SecuredPackRunner, type AuthorizedPackContext } from '../../../packages/core/src/evals/packs/execution';

const suite = makeSuite();
const registry = createTrustedRegistry({ sourceRevision: process.env.PACK_TRACK_A_REVISION ?? 'f0068733ca49c37f40fd7de279325f21a4b5fbbb', sourcePath: 'packages/core/src/redteam/library.ts', specs: RED_TEAM_LIBRARY });
const context: AuthorizedPackContext = { jobId: suite.jobId, environment: 'fixture', authorizationId: 'approved-job', sourceRuleIds: ['safety-policy-v1'], targetConfigDigest: 'a'.repeat(64) };
const draft = { packId: 'track-a-redteam', version: 'reviewed.1', baseDigest: suite.digest,
  authorization: { authorizationId: context.authorizationId, sourceRuleIds: [...context.sourceRuleIds], targetConfigDigest: context.targetConfigDigest },
  scenarioIds: ['rt_inj_direct_fake_system', 'rt_inj_document', 'rt_unknown_case'] };
const freeze = (input = draft) => freezePack(input, registry, { reviewerId: 'reviewer', reviewedAt: '2026-11-07T20:00:00.000Z', contentDigest: packReviewDigest(input, registry) });
const manifest = freeze();
const migration = readFileSync(new URL('../../../packages/core/src/evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8');

describe('appended packs with real PostgreSQL checkpoint SQL (PGlite)', () => {
  let engine: PGlite;
  let db: AgentTransactionalSql;
  let calls: number;
  let runner: SecuredPackRunner;
  const fresh = (resolved = context, port = runner) => createPackExecutionService({ registry, checkpoints: new PostgresTextCheckpointStore(db), runner: port, resolve: async () => resolved, verifyReview: async()=>undefined });
  const request = () => ({ runId: 'run-1', manifest, baseSuite: suite, baseRun: null });
  beforeEach(async () => {
    engine = new PGlite(); await engine.exec(migration); calls = 0;
    db = { query: <T>(sql: string, params?: unknown[]) => engine.query<T>(sql, params), transaction: fn => engine.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })) };
    runner = { capabilityVersion: 'secured_pack_runner.v1', supports: () => true, async execute(entry, dispatch) {
      calls++;
      // Read from SQL DURING dispatch: complete expected manifest precedes the target operation.
      const saved = await new PostgresTextCheckpointStore(db).get({ jobId: suite.jobId, kind: 'appended_pack:manifest', id: dispatch.runId });
      expect(saved?.state).toBe('completed');
      expect((saved as { value: { manifest: typeof manifest } }).value.manifest.inventory.map(item => item.id)).toContain(entry.id);
      return { id: entry.id, specDigest: entry.specDigest, status: 'pass', checks: entry.spec!.rules.map((_, i) => ({ id: `${entry.id}.rule.${i + 1}`, status: 'pass', detail: 'No forbidden marker.', evidenceQuotes: [] })) };
    } };
  });
  afterEach(async () => { await engine.close(); });

  it('authenticates external review authority before persisting or dispatching a pack',async()=>{
    const denied=createPackExecutionService({registry,checkpoints:new PostgresTextCheckpointStore(db),runner,resolve:async()=>context,verifyReview:async()=>{throw new Error('review_not_authorized');}});
    await expect(denied.run(request())).rejects.toThrow('review_not_authorized');
    expect(calls).toBe(0);
    expect(await new PostgresTextCheckpointStore(db).get({jobId:suite.jobId,kind:'appended_pack:manifest',id:'run-1'})).toBeNull();
  });

  it('retains complete immutable expected inventory, independent base status and fresh-adapter restart evidence', async () => {
    const result = await fresh().run(request());
    expect(result.base.status).toBe('unknown');
    expect(result.base.expectedIds).toHaveLength(12);
    expect(result.pack.status).toBe('quarantined');
    expect(result.pack.results.map(r => r.status)).toEqual(['pass', 'quarantined', 'quarantined']);
    expect(calls).toBe(1);
    expect(await fresh().run(request())).toEqual(result);
    expect(await fresh().report(suite.jobId, 'run-1')).toEqual(result);
    expect(calls).toBe(1);
  });

  it('fences lost responses as ambiguous and never redispatches them after restart', async () => {
    runner.execute = async () => { calls++; throw new Error('provider body or credential must not persist'); };
    const result = await fresh().run(request());
    expect(result.pack.results[0]).toMatchObject({ status: 'unknown', reason: 'dispatch_ambiguous_requires_reconciliation' });
    const restarted = await fresh().run(request());
    expect(restarted.pack.results[0]!.status).toBe('unknown');
    expect(JSON.stringify(await fresh().report(suite.jobId, 'run-1'))).not.toContain('credential');
    expect(calls).toBe(1);
  });

  it('never replays a still-pending dispatch from a second worker', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const normal = runner.execute;
    runner.execute = async (entry, dispatch) => { entered(); await gate; return normal(entry, dispatch); };
    const first = fresh().run(request());
    await started;
    const second = await fresh().run(request());
    expect(second.pack.results[0]).toMatchObject({ status: 'unknown', reason: 'dispatch_pending_requires_reconciliation' });
    expect(calls).toBe(0);
    release();
    expect((await first).pack.results[0]!.status).toBe('pass');
    expect(calls).toBe(1);
  });

  it('quarantines unsupported runner capability without dispatch, including after restart', async () => {
    runner.supports = () => false;
    const result = await fresh().run(request());
    expect(result.pack.results[0]).toMatchObject({ status: 'quarantined', reason: 'runner_unsupported_semantics' });
    expect(await fresh().report(suite.jobId, 'run-1')).toEqual(result);
    expect(calls).toBe(0);
  });

  it('refuses same-run changed expected inventory/version and changed actual target before dispatch', async () => {
    await fresh().run(request());
    const changed = freeze({ ...draft, version: 'reviewed.2', scenarioIds: draft.scenarioIds.slice(0, 2) });
    await expect(fresh().run({ ...request(), manifest: changed })).rejects.toThrow('identity_conflict');
    await expect(fresh({ ...context, targetConfigDigest: 'b'.repeat(64) }).run(request())).rejects.toThrow('authorized_context_mismatch');
    await expect(fresh({ ...context, sourceRuleIds: ['different-policy'] }).report(suite.jobId, 'run-1')).rejects.toThrow('authorized_context_mismatch');
    expect(calls).toBe(1);
  });

  it('refuses empty/forged passing runner evidence and preserves infrastructure distinction', async () => {
    runner.execute = async entry => ({ id: entry.id, specDigest: entry.specDigest, status: 'pass', checks: [] });
    const result = await fresh().run(request());
    expect(result.pack.results[0]!.status).toBe('infrastructure_error');
    expect(result.pack.status).toBe('infrastructure_error');
    expect((await fresh().report(suite.jobId, 'run-1')).pack.results[0]!.status).toBe('infrastructure_error');
  });

  it('derives result status from complete checks instead of trusting a claimed pass', async () => {
    runner.execute = async entry => ({ id: entry.id, specDigest: entry.specDigest, status: 'pass', checks: [{ id: `${entry.id}.rule.1`, status: 'not_assessed', detail: 'No judgment.', evidenceQuotes: [] }] });
    const result = await fresh().run(request());
    expect(result.pack.results[0]!.status).toBe('not_assessed');
    expect(result.pack.status).toBe('not_assessed');
  });

  it('keeps successful historical frozen12 separate from appended quarantines', async () => {
    const baseRun = await executeSuite(suite, 'base-1', { target: { send: async () => ({ ok: true, text: 'READY', latencyMs: 1 }) }, judge: null, evaluateObjective: evaluateObjectiveCheck });
    const result = await fresh().run({ ...request(), baseRun });
    expect(result.base.status).toBe('pass');
    expect(result.base.digest).toBe(suite.digest);
    expect(result.pack.status).toBe('quarantined');
    const missing = { ...baseRun, executions: baseRun.executions.slice(0, 11) };
    await expect(fresh().run({ ...request(), runId: 'missing', baseRun: missing })).rejects.toThrow('scope_mismatch');
  });

  it('compares only consistent assessed pairs while retaining all expected cases', async () => {
    const left = await fresh().run(request());
    const right = await fresh().run({ ...request(), runId: 'run-2' });
    expect(comparePackRuns(left, right, registry)).toEqual([
      { id: draft.scenarioIds[0], paired: true, reason: null, left: 'pass', right: 'pass' },
      { id: draft.scenarioIds[1], paired: false, reason: 'unassessed_pair', left: 'quarantined', right: 'quarantined' },
      { id: draft.scenarioIds[2], paired: false, reason: 'unassessed_pair', left: 'quarantined', right: 'quarantined' },
    ]);
    const smaller = freeze({ ...draft, version: 'smaller', scenarioIds: draft.scenarioIds.slice(0, 1) });
    const incomplete = await fresh().run({ ...request(), runId: 'run-3', manifest: smaller });
    expect(comparePackRuns(left, incomplete, registry).map(p => p.reason)).toEqual([null, 'missing_expected_case', 'missing_expected_case']);
    const forged=structuredClone(right);
    forged.pack.results[1]!.status='pass';
    expect(comparePackRuns(forged, forged, registry)[1]).toMatchObject({paired:false,reason:'unassessed_pair',left:'quarantined',right:'quarantined'});
  });
});

import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentTransactionalSql } from '../../../agents/postgres-ports';
import { PostgresTextCheckpointStore, type TextCheckpointStore } from '../../integration/checkpoints';
import { createScenarioDispatch, type ScenarioDispatchInput, type ScenarioDispatchDeps } from './index';
const migration = readFileSync(new URL('../../integration/migrations/001-text-integration.sql', import.meta.url), 'utf8');
let sql: PGlite; let db: AgentTransactionalSql; let sequence = 0;
beforeAll(async () => {
  sql = new PGlite(); await sql.exec(migration);
  db = { query: (q, p) => sql.query(q, p), transaction: fn => sql.transaction(tx => fn({ query: (q, p) => tx.query(q, p) })) };
});
afterAll(async () => { await sql.close(); });
const input = (): ScenarioDispatchInput => ({ ownerId: 'owner', runId: `run-${++sequence}`, environmentId: 'env', suiteId: 'suite', scenarioId: 'S1', worldId: 'world', k: 1, budgetMicroUsd: 100, engineVersion: 'engine-v1', environment: { tools: [] }, inventory: [{ id: 'S1' }], scenario: { id: 'S1' }, versions: { model: 'test-model' } });
type Result = { scenarioId: string; evidence: string; passed: boolean };
function deps(overrides: Partial<ScenarioDispatchDeps<Result>> = {}): ScenarioDispatchDeps<Result> {
  return { checkpoints: new PostgresTextCheckpointStore(db), authorize: async () => true, currentSecrets: async () => [],
    validateResult(value, scope) {
      const v = value as Result;
      if (!v || v.scenarioId !== scope.scenarioId || typeof v.evidence !== 'string' || typeof v.passed !== 'boolean' || Object.keys(v).length !== 3) throw new Error('bad_result');
      return v;
    }, execute: async scope => ({ scenarioId: scope.scenarioId, evidence: 'exact evidence', passed: true }), ...overrides };
}
function wrap(store: TextCheckpointStore, overrides: Partial<TextCheckpointStore>): TextCheckpointStore {
  return { claim: store.claim.bind(store), get: store.get.bind(store), complete: store.complete.bind(store), release: store.release.bind(store), markAmbiguous: store.markAmbiguous.bind(store), ...overrides };
}
describe('whole-scenario durable dispatch (actual SQL, no providers)', () => {
  it('restores completed result after caller publication failed without re-execution', async () => {
    const scope = input(); const execute = vi.fn(deps().execute);
    const first = await createScenarioDispatch(deps({ execute }))(scope);
    expect(first).toMatchObject({ status: 'completed', replayed: false });
    // Model putRunResult throwing after dispatch completion: fresh adapter restores the complete evidence.
    const replay = await createScenarioDispatch(deps({ execute }))(scope);
    expect(replay).toEqual({ ...first, replayed: true }); expect(execute).toHaveBeenCalledTimes(1);
    if (replay.status === 'completed') replay.value.evidence = 'caller mutation';
    expect(await createScenarioDispatch(deps({ execute }))(scope)).toMatchObject({ value: { evidence: 'exact evidence' } });
  });
  it('allows only one simultaneous dispatch and returns unresolved to concurrent retries', async () => {
    const scope = input(); let finish!: () => void; let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; }); const wait = new Promise<void>(r => { finish = r; });
    const execute = vi.fn(async () => { entered(); await wait; return { scenarioId: 'S1', evidence: 'once', passed: false }; });
    const run = createScenarioDispatch(deps({ execute })); const first = run(scope); await started;
    const retries = await Promise.all(Array.from({ length: 6 }, () => run(scope)));
    expect(retries.every(v => v.status === 'unresolved' && v.reason === 'pending')).toBe(true);
    finish(); expect(await first).toMatchObject({ status: 'completed' }); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('retains ambiguous effects across adapter restart and never releases their claim', async () => {
    const scope = input(); const execute = vi.fn(async () => { throw new Error('provider secret detail'); });
    const store = new PostgresTextCheckpointStore(db); const release = vi.fn(store.release.bind(store));
    expect(await createScenarioDispatch(deps({ execute, checkpoints: wrap(store, { release }) }))(scope)).toEqual({ status: 'unresolved', reason: 'ambiguous' });
    expect(await createScenarioDispatch(deps({ execute }))(scope)).toEqual({ status: 'unresolved', reason: 'ambiguous' });
    expect(execute).toHaveBeenCalledTimes(1); expect(release).not.toHaveBeenCalled();
  });
  it.each(['ownerId', 'worldId', 'environment', 'inventory', 'versions', 'engineVersion', 'k', 'budgetMicroUsd'] as const)('rejects changed %s under an existing run/scenario fence', async field => {
    const scope = input(); const execute = vi.fn(deps().execute); const run = createScenarioDispatch(deps({ execute }));
    expect(await run(scope)).toMatchObject({ status: 'completed' });
    const changed = { ...scope, [field]: typeof scope[field] === 'number' ? 2 : typeof scope[field] === 'string' ? 'changed' : { changed: true } };
    expect(await run(changed)).toEqual({ status: 'unresolved', reason: 'storage' }); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('binds a genuinely standalone run without inventing a suite ID', async () => {
    const scope = { ...input(), suiteId: null }; const execute = vi.fn(deps().execute);
    const run = createScenarioDispatch(deps({ execute }));
    expect(await run(scope)).toMatchObject({ status: 'completed' });
    expect(await run(scope)).toMatchObject({ status: 'completed', replayed: true });
    expect(await run({ ...scope, suiteId: 'later-suite' })).toEqual({ status: 'unresolved', reason: 'storage' });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('detaches and freezes caller input before awaiting authorization', async () => {
    const scope = input(); let unblock!: () => void; const gate = new Promise<void>(r => { unblock = r; });
    const execute = vi.fn(async (actual: Readonly<ScenarioDispatchInput>) => {
      expect(actual.worldId).toBe('world'); expect(Object.isFrozen(actual.environment)).toBe(true);
      return { scenarioId: 'S1', evidence: 'bound', passed: true };
    });
    const pending = createScenarioDispatch(deps({ execute, authorize: async () => { await gate; return true; } }))(scope);
    scope.worldId = 'forged'; (scope.environment as { tools: unknown[] }).tools.push('forged'); unblock();
    expect(await pending).toMatchObject({ status: 'completed' }); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects pre-claim authorization without storage or dispatch', async () => {
    const store = new PostgresTextCheckpointStore(db); const claim = vi.fn(store.claim.bind(store)); const execute = vi.fn(deps().execute);
    expect(await createScenarioDispatch(deps({ authorize: async () => false, checkpoints: wrap(store, { claim }), execute }))(input())).toEqual({ status: 'unresolved', reason: 'unauthorized' });
    expect(claim).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it('rechecks authority after claim and before completed replay', async () => {
    const scope = input(); let allowed = true; const execute = vi.fn(deps().execute); const store = new PostgresTextCheckpointStore(db);
    const claim = async (...args: Parameters<TextCheckpointStore['claim']>) => { const result = await store.claim(...args); allowed = false; return result; };
    const result = await createScenarioDispatch(deps({ execute, authorize: async () => allowed, checkpoints: wrap(store, { claim }) }))(scope);
    expect(result).toEqual({ status: 'unresolved', reason: 'unauthorized' }); expect(execute).not.toHaveBeenCalled();
    const completeScope = input(); await createScenarioDispatch(deps())(completeScope);
    expect(await createScenarioDispatch(deps({ authorize: async () => false, execute }))(completeScope)).toMatchObject({ status: 'unresolved', reason: 'unauthorized' });
  });
  it('retains completed evidence on in-flight revocation without publishing it', async () => {
    const scope = input(); let allowed = true;
    const execute = vi.fn(async () => { allowed = false; return { scenarioId: 'S1', evidence: 'retained', passed: true }; });
    const run = createScenarioDispatch(deps({ execute, authorize: async () => allowed }));
    expect(await run(scope)).toEqual({ status: 'unresolved', reason: 'unauthorized' });
    allowed = true; expect(await run(scope)).toMatchObject({ status: 'completed', replayed: true, value: { evidence: 'retained' } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('screens rotated secrets on replay and after completion storage', async () => {
    const scope = input(); let secrets: string[] = []; const store = new PostgresTextCheckpointStore(db);
    const complete = async (...args: Parameters<TextCheckpointStore['complete']>) => { await store.complete(...args); secrets = ['exact evidence']; };
    const execute = vi.fn(deps().execute); const run = createScenarioDispatch(deps({ execute, currentSecrets: async () => secrets, checkpoints: wrap(store, { complete }) }));
    expect(await run(scope)).toEqual({ status: 'unresolved', reason: 'secret' });
    expect(await run(scope)).toMatchObject({ status: 'unresolved' }); expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('screens rotation during publication authorization (replay=%s)', async replay => {
    const scope = input(); if (replay) await createScenarioDispatch(deps())(scope);
    let secrets: string[] = []; let checks = 0;
    const execute = vi.fn(deps().execute);
    const run = createScenarioDispatch(deps({ execute, currentSecrets: async () => secrets,
      authorize: async () => { checks++; if (checks === (replay ? 2 : 3)) secrets = ['exact evidence']; return true; },
    }));
    expect(await run(scope)).toEqual({ status: 'unresolved', reason: 'secret' });
    expect(execute).toHaveBeenCalledTimes(replay ? 0 : 1);
  });
  it('screens escaped and short known secret values before dispatch', async () => {
    const execute = vi.fn(deps().execute); const scope = input(); scope.environment = { note: 'x"y' };
    expect(await createScenarioDispatch(deps({ execute, currentSecrets: async () => ['x"y'] }))(scope)).toEqual({ status: 'unresolved', reason: 'secret' });
    expect(execute).not.toHaveBeenCalled();
  });
  it('retains ambiguous fence if completion fails, even if ambiguity persistence fails too', async () => {
    const scope = input(); const execute = vi.fn(deps().execute); const store = new PostgresTextCheckpointStore(db);
    const bad = wrap(store, { complete: async () => { throw new Error('offline'); }, markAmbiguous: async () => { throw new Error('offline'); } });
    expect(await createScenarioDispatch(deps({ execute, checkpoints: bad }))(scope)).toEqual({ status: 'unresolved', reason: 'storage' });
    expect(await createScenarioDispatch(deps({ execute }))(scope)).toEqual({ status: 'unresolved', reason: 'pending' }); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects lossy result validation and malformed result without redispatch', async () => {
    const execute = vi.fn(async () => ({ scenarioId: 'S1', evidence: 'e', passed: true, hidden: 1 })); const scope = input();
    const run = createScenarioDispatch(deps({ execute, validateResult: raw => { const v = raw as Result; return { scenarioId: v.scenarioId, evidence: v.evidence, passed: v.passed }; } }));
    expect(await run(scope)).toMatchObject({ status: 'unresolved', reason: 'ambiguous' });
    expect(await run(scope)).toMatchObject({ status: 'unresolved', reason: 'ambiguous' }); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid input before claiming', async () => {
    const execute = vi.fn(deps().execute);
    for (const change of [{ k: 0 }, { budgetMicroUsd: NaN }, { environment: { lost: undefined } }, { environment: new Date() }]) {
      expect(await createScenarioDispatch(deps({ execute }))({ ...input(), ...change })).toEqual({ status: 'unresolved', reason: 'invalid_input' });
    }
    expect(execute).not.toHaveBeenCalled();
  });
});

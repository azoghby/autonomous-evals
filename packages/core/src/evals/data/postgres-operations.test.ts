import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTransactionalSql } from '../../agents/postgres-ports';
import { reviewDigest } from './binding';
import { createDataCostCapture } from './orchestration';
import { createAuthenticatedDataReviewLedger } from './review-ledger';
import { createPostgresDataOperationLedger, type PostgresDataOperationScope } from './postgres-operations';

const migration = readFileSync(new URL('./persistence-migrations/002-data-operations.sql', import.meta.url), 'utf8');
const digest = reviewDigest({ request: 'fixture' });
const scope: PostgresDataOperationScope = { tenantId: 'tenant', jobId: 'job', ownerId: 'data_service', authenticateOwner: async () => ({ ownerId: 'data_service' }) };
describe('PostgreSQL operation ledger (actual SQL, PGlite serializes transactions)', () => {
  let engine: PGlite;
  let db: AgentTransactionalSql;
  let ledger: ReturnType<typeof createPostgresDataOperationLedger>;
  beforeEach(async () => {
    engine = new PGlite(); await engine.exec(migration);
    db = { query: (sql, params) => engine.query(sql, params), transaction: fn => engine.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params) })) };
    ledger = createPostgresDataOperationLedger(db, scope);
  });
  afterEach(async () => { await engine.close(); });
  it('has exactly one claim winner, replay never owns or redispatches, identity immutable', async () => {
    const dispatch = vi.fn(async () => ({ status: 'complete', data: [] }));
    await Promise.all(Array.from({ length: 12 }, async () => {
      const claim = await createPostgresDataOperationLedger(db, scope).claim('generation', digest);
      if (claim.claimed) await ledger.complete('generation', digest, await dispatch());
    }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await ledger.claim('generation', digest)).claimed).toBe(false);
    await expect(ledger.claim('generation', 'b'.repeat(64))).rejects.toThrow('immutable');
  });
  it('pins tenant/job/owner and rejects unauthenticated mutations', async () => {
    const config = { ...scope }; const pinned = createPostgresDataOperationLedger(db, config);
    config.tenantId = 'other'; config.ownerId = 'other';
    await pinned.claim('key', digest);
    expect(await ledger.get('key')).not.toBeNull();
    for (const foreign of [{ ...scope, tenantId: 'other' }, { ...scope, jobId: 'other' }]) {
      expect(await createPostgresDataOperationLedger(db, foreign).get('key')).toBeNull();
    }
    for (const authenticateOwner of [async () => null, async () => ({ ownerId: 'other' })]) {
      const denied = createPostgresDataOperationLedger(db, { ...scope, authenticateOwner });
      await expect(denied.claim('key', digest)).rejects.toThrow('unauthorized');
      await expect(denied.complete('key', digest, {})).rejects.toThrow('unauthorized');
    }
  });
  it('never steals a pending claim; only authenticated bound reconciliation can complete for another owner', async () => {
    await ledger.claim('key', digest);
    const foreignScope = { ...scope, ownerId: 'reconciler', authenticateOwner: async () => ({ ownerId: 'reconciler' }) };
    const foreign = createPostgresDataOperationLedger(db, foreignScope);
    expect((await foreign.claim('key', digest)).claimed).toBe(false);
    await expect(foreign.complete('key', digest, { status: 'complete' })).rejects.toThrow('unauthorized');
    await expect(foreign.complete('key', digest, {}, 'invented')).rejects.toThrow('unauthorized');
    const result = { status: 'complete' };
    const authorize = vi.fn(async () => true);
    const reconciler = createPostgresDataOperationLedger(db, { ...foreignScope, authorizeReconciliation: authorize });
    await reconciler.complete('key', digest, result, 'verified_receipt');
    expect(authorize).toHaveBeenCalledWith({ tenantId: 'tenant', jobId: 'job', key: 'key', digest, resultDigest: reviewDigest(result), ownerId: 'reconciler', claimOwnerId: 'data_service', receiptId: 'verified_receipt' });
    await reconciler.complete('key', digest, result, 'verified_receipt');
    await expect(reconciler.complete('key', digest, result, 'different')).rejects.toThrow('immutable');
    await expect(ledger.complete('key', digest, result)).rejects.toThrow('immutable');
    await expect(ledger.complete('key', digest, { changed: true })).rejects.toThrow('immutable');
    expect((await ledger.get('key'))?.reconciliationReceipt).toBe('verified_receipt');
  });
  it('preserves lost claim and completion acknowledgements through fresh service instances', async () => {
    const lostAck: AgentTransactionalSql = { query: db.query, transaction: async fn => { await db.transaction(fn); throw new Error('sensitive ack'); } };
    const unreliable = createPostgresDataOperationLedger(lostAck, scope);
    await expect(unreliable.claim('generation', digest)).rejects.toThrow(/^data_operation_failed$/);
    const fresh = createPostgresDataOperationLedger(db, scope);
    expect(await fresh.claim('generation', digest)).toEqual({ claimed: false, record: { key: 'generation', digest, state: 'pending' } });
    await expect(unreliable.complete('generation', digest, { status: 'complete' })).rejects.toThrow(/^data_operation_failed$/);
    expect((await fresh.claim('generation', digest)).record).toEqual({ key: 'generation', digest, state: 'complete', result: { status: 'complete' } });
    await fresh.complete('generation', digest, { status: 'complete' });
  });
  it('supports durable idempotent cost and authenticated independent review after service restart', async () => {
    const entry = { taskKey: 'task', operationKey: 'generation', cost: { jobId: 'job', source: 'naive_session' as const, role: null, externalId: 'billing_receipt', purpose: 'generation', microUsd: 10_000, measured: true, recordedAt: '2026-11-07T12:00:00Z' } };
    await createDataCostCapture(ledger)(entry);
    const fresh = createPostgresDataOperationLedger(db, scope);
    await createDataCostCapture(fresh)(entry);
    expect((await fresh.get('generation:cost'))?.result).toEqual(entry);
    const task = { taskId: 'task', jobId: 'job', description: 'Review fixture', targetId: 'target', factualAnswersRequired: false, requirements: [] };
    const batch = { sources: [], cases: [] };
    const intake = () => createAuthenticatedDataReviewLedger({ operations: createPostgresDataOperationLedger(db, scope), authenticateHuman: async () => ({ principalId: 'independent_human' }) });
    await intake().submit({ receiptId: 'review_receipt', task, candidates: batch, reviewed: batch, decision: 'approved' });
    const { dataReviewRequestDigest } = await import('./orchestration');
    expect(await intake().readReview({ digest: dataReviewRequestDigest(task, batch), task, data: batch })).toMatchObject({ status: 'decided', review: { principalId: 'independent_human' } });
    await expect(intake().submit({ receiptId: 'review_receipt', task, candidates: batch, reviewed: batch, decision: 'rejected' })).rejects.toThrow('immutable');
  });
  it.each([undefined, NaN, Infinity, new Date(), () => 1, '\u0000', '\ud800', BigInt(1)])('rejects lossy/non-JSON result %#', async result => {
    await ledger.claim('key', digest);
    await expect(ledger.complete('key', digest, result)).rejects.toThrow('invalid');
    expect((await ledger.get('key'))?.state).toBe('pending');
  });
  it('rejects getters, custom serialization, sparse arrays, cycles and symbols without executing them', async () => {
    await ledger.claim('key', digest); let invoked = 0;
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { invoked++; return true; } });
    const cyclic: any = {}; cyclic.self = cyclic;
    class CustomArray extends Array { toJSON() { invoked++; return []; } }
    for (const value of [Object.assign(new Array(1), { extra: 'value' }), new CustomArray(), getter, { toJSON() { invoked++; return {}; } }, new Array(2), cyclic, { [Symbol('hidden')]: true }]) {
      await expect(ledger.complete('key', digest, value)).rejects.toThrow('invalid');
    }
    expect(invoked).toBe(0);
  });
  it('accepts Unicode/SQL text, snapshots results, bounds bytes and screens current secrets on all replay paths', async () => {
    const secrets: string[] = [];
    const screened = createPostgresDataOperationLedger(db, { ...scope, knownSecrets: () => secrets });
    await screened.claim('key', digest);
    const input = { value: "🧪 '); DROP TABLE operations; -- opaque-confidential-fixture" };
    const expected = structuredClone(input);
    await screened.complete('key', digest, input); input.value = 'mutated';
    expect((await screened.get('key'))?.result).toEqual(expected);
    secrets.push('opaque-confidential-fixture');
    await expect(screened.get('key')).rejects.toThrow('invalid');
    await expect(screened.claim('key', digest)).rejects.toThrow('invalid');
    await expect(screened.complete('key', digest, expected)).rejects.toThrow('invalid');
    await ledger.claim('large', digest);
    await expect(ledger.complete('large', digest, 'a'.repeat(1_000_001))).rejects.toThrow('invalid');
  });
  it('accepts JSON null, rejects missing completion and verifies receipts even for the original owner', async () => {
    await expect(ledger.complete('missing', digest, null)).rejects.toThrow('immutable');
    await ledger.claim('key', digest);
    await expect(ledger.complete('key', digest, null, 'unverified')).rejects.toThrow('unauthorized');
    await ledger.complete('key', digest, null);
    expect((await ledger.get('key'))?.result).toBeNull();
    await ledger.complete('key', digest, null);
  });
  it('rolls back completion when current secrets change before returned row validation', async () => {
    const secrets: string[] = [];
    await ledger.claim('key', digest);
    const observed: AgentTransactionalSql = { query: db.query, transaction: fn => db.transaction(tx => fn({ async query<T>(sql: string, params?: unknown[]) {
      const answer = await tx.query<T>(sql, params);
      if (sql.startsWith('UPDATE')) secrets.push('new-confidential-fixture');
      return answer;
    } })) };
    await expect(createPostgresDataOperationLedger(observed, { ...scope, knownSecrets: () => secrets }).complete('key', digest, { value: 'new-confidential-fixture' })).rejects.toThrow('invalid');
    expect((await ledger.get('key'))?.state).toBe('pending');
  });
  it('database enforces immutable identity/result/receipt and no deletion', async () => {
    await ledger.claim('key', digest); await ledger.complete('key', digest, { immutable: true });
    for (const sql of ["UPDATE evaluation_data_persistence.operations SET owner_id = 'other'", "UPDATE evaluation_data_persistence.operations SET result = '{}'", "UPDATE evaluation_data_persistence.operations SET reconciliation_receipt = 'other'", 'DELETE FROM evaluation_data_persistence.operations']) {
      await expect(engine.query(sql)).rejects.toThrow('immutable');
    }
  });
  it('validates returned rows and rolls back failed completion; errors never expose parameters', async () => {
    await ledger.claim('key', digest);
    const bad: AgentTransactionalSql = { query: db.query, transaction: fn => db.transaction(tx => fn({ async query<T>(sql: string, params?: unknown[]) {
      const answer = await tx.query<T>(sql, params);
      return sql.startsWith('UPDATE') ? { rows: [{}] as T[] } : answer;
    } })) };
    await expect(createPostgresDataOperationLedger(bad, scope).complete('key', digest, {})).rejects.toThrow('invalid');
    expect((await ledger.get('key'))?.state).toBe('pending');
    const failure: AgentTransactionalSql = { query: async () => { throw new Error('secret SQL parameters'); }, transaction: async () => { throw new Error('secret SQL parameters'); } };
    await expect(createPostgresDataOperationLedger(failure, scope).get('key')).rejects.toThrow(/^data_operation_failed$/);
  });
});

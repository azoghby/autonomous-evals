import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PostgresTextCheckpointStore } from '../../../../packages/core/src/evals/integration/checkpoints';
import type { AgentTransactionalSql } from '../../../../packages/core/src/agents/postgres-ports';
import { createAuthenticatedDataReviewLedger } from '../../../../packages/core/src/evals/data/review-ledger';
import { createFileDataOperationLedger } from '../../../../packages/core/src/evals/data/operation-ledger';
import { dataReviewRequestDigest } from '../../../../packages/core/src/evals/data/orchestration';
import { fixtureSpec } from '../../../../packages/core/src/evals/data/adapters/fixtures';
import { database, digestA, digestB, plan, projector, runValue, save, scope } from './helpers';
const engines: Awaited<ReturnType<typeof database>>['engine'][] = [], roots: string[] = [];
afterEach(async () => { await Promise.all(engines.splice(0).map(e => e.close())); await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))); });
async function fixture() { const f = await database(); engines.push(f.engine); return f; }
// Regression coverage for detached authorization and checkpoint identities.
describe('Regression: identity is pinned across await boundaries', () => {
  it('D1 accepts live SQL evidence after the resolved test plan environment is mutated during read', async () => {
    const f = await fixture(), p = plan(); await save(f.store, p.checkpoints[0]!.key, runValue('live'));
    expect(p.environment).toBe('test');
    await expect(projector(p, f.store, undefined, () => { p.environment = 'live'; }).project(scope)).rejects.toThrow();
  });
  it('D2 SQL checkpoint get validates a changed digest rather than the digest captured at invocation', async () => {
    const f = await fixture(), p = plan(), key = { ...p.checkpoints[0]!.key };
    await save(f.store, { ...key, inputDigest: digestB }, { marker: 'different-input' });
    let selectedDigest = '';
    const gated: AgentTransactionalSql = { transaction: f.db.transaction, query: async <T>(sql: string, params?: unknown[]) => {
      const result = await f.db.query<T>(sql, params);
      selectedDigest = key.inputDigest; key.inputDigest = digestB;
      return result;
    } };
    expect(key.inputDigest).toBe(digestA);
    await expect(new PostgresTextCheckpointStore(gated).get(key)).rejects.toThrow('identity_conflict');
    expect(selectedDigest).toBe(digestA);
    // Unmutated control must refuse the same persisted row.
    await expect(f.store.get({ ...key, inputDigest: digestA })).rejects.toThrow('identity_conflict');
  });
  it('D3 review read checks a mutated request digest after the durable lookup captured the original', async () => {
    const root = await mkdtemp(join(tmpdir(), 'identity-review-')); roots.push(root);
    const operations = createFileDataOperationLedger(root);
    const task = structuredClone(fixtureSpec), data = { sources: [], cases: [] };
    const intake = createAuthenticatedDataReviewLedger({ operations, authenticateHuman: async () => ({ principalId: 'human-reviewer' }) });
    await intake.submit({ receiptId: 'immutable-receipt', task, candidates: data, reviewed: data, decision: 'approved' });
    const request = { task, data, digest: dataReviewRequestDigest(task, data) };
    const original = structuredClone(request);
    const reader = createAuthenticatedDataReviewLedger({ authenticateHuman: async () => null, operations: {
      ...operations, get: async key => {
        const result = await operations.get(key);
        request.task.jobId = 'other-job';
        request.digest = dataReviewRequestDigest(request.task, request.data);
        return result;
      },
    } });
    // Initially valid input is rejected because post-await verification uses a new digest.
    expect((await reader.readReview(request)).status).toBe('decided');
    expect(request.digest).not.toBe(original.digest);
    expect((await intake.readReview(original)).status).toBe('decided');
  });
});

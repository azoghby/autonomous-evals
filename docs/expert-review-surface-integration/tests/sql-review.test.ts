import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const state = vi.hoisted(() => ({
  pg: undefined as any,
  viewer: null as null | { id: string; email: string; isOperator: boolean },
  afterQuery: undefined as undefined | ((sql: string, params: unknown[]) => void),
  queries: [] as string[],
}));
vi.mock('@/server/session', () => ({ getCurrentCustomer: vi.fn(async () => state.viewer && { ...state.viewer }) }));
// Only the remote DB transport is replaced. The production pool transaction adapter, SQL ledgers,
// immutable migrations, requireOperator, deterministic validators and route handlers all run unchanged.
vi.mock('@neondatabase/serverless', () => ({ Pool: class {
  async query(sql: string, params: unknown[] = []) {
    state.queries.push(sql);
    const result = await state.pg.query(sql, params);
    state.afterQuery?.(sql, params); // Deliberately AFTER PostgreSQL has performed the awaited operation.
    return result;
  }
  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
} }));
vi.mock('@ae/core/integration/eval-services', () => ({ buildAgentDeps: () => { throw new Error('provider forbidden'); } }));
vi.mock('@/server/automated-expert-owner', () => ({ createOwnerExpertStep: () => { throw new Error('send forbidden'); } }));
vi.mock('@/server/automated-expert-responses', () => ({ createSqlExpertResponseService: () => { throw new Error('provider forbidden'); } }));
vi.mock('@/server/job-store', () => ({ recordCost: () => { throw new Error('cost forbidden'); }, jobKnownCostMicroUsd: () => { throw new Error('cost forbidden'); } }));

import { readExpertWorkflowReview } from '@/server/expert-data-production';
import { GET as detail, POST as submit } from '@review-routes/[jobId]/[kind]/[digest]/route';
import { reviewDigest, answerReviewContextDigest } from '@ae/core/evals/data/binding';
import { expertContributionContextDigest } from '@ae/core/evals/data/expert';
import { dataReviewRequestDigest } from '@ae/core/evals/data/orchestration';
import { createPostgresDataOperationLedger } from '@ae/core/evals/data/postgres-operations';
import { createAuthenticatedDataReviewLedger } from '@ae/core/evals/data/review-ledger';
import { pooledCalendarDatabase } from '@ae/core/simulator/pool';
import type { DataTaskSpec } from '@ae/core/evals/data/types';
import type { DataBatch } from '@ae/core/evals/data/acquisition';
import type { ExpertContribution } from '@ae/core/evals/data/expert';

const stage = process.env.EXPERT_REVIEW_STAGE ?? '/tmp/expert-review-api-stage';
const jobId = '1b1f2b21-a125-4b3e-b234-f828342dd555';
const otherJobId = '2b1f2b21-a125-4b3e-b234-f828342dd555';
const tenantId = '3b1f2b21-a125-4b3e-b234-f828342dd555';
const principalId = '4b1f2b21-a125-4b3e-b234-f828342dd555';
const timestamp = '2026-11-08T12:00:00Z';
const task: DataTaskSpec = { taskId: 'task-one', jobId, description: 'Determine the capital',
  requirements: [{ id: 'capital', description: 'Country capital', minimumCases: 1 }], factualAnswersRequired: true,
  targetId: 'target-one', requiredUses: ['evaluation'] };
const candidates: DataBatch = { sources: [{ id: 'source-one', url: 'https://example.org/evidence', content: 'Paris is the capital of France.',
  license: { name: 'CC0', url: 'https://example.org/license', permission: 'allowed', allowedUses: ['evaluation'] },
  provenance: { origin: 'expert', producerId: 'contributor-one', retrievedAt: timestamp, contentHash: 'retained-content-hash' },
  review: { status: 'pending', reviewerId: '', reviewedAt: timestamp, notes: '' } }],
  cases: [{ id: 'case-one', input: 'Capital of France?', requirementIds: ['capital'], synthetic: false,
    generatorId: 'contributor-one', sourceIds: ['source-one'], expectedAnswer: 'Paris' }] };
const contribution: ExpertContribution = { id: 'contribution-one', taskId: task.taskId, contributorId: 'contributor-one',
  consent: { evaluation: true, allowedUses: ['evaluation'], receiptUrl: 'https://example.org/consent' },
  qualificationEvidence: ['Domain qualification documented'], ...candidates };
const contributionSnapshot = { task, contribution };
const corpusSnapshot = { task, candidates };
const contributionDigest = expertContributionContextDigest(task, contribution);
const corpusDigest = dataReviewRequestDigest(task, candidates);
const context = (kind: 'contribution' | 'corpus', id = jobId) => ({ params: Promise.resolve({ jobId: id, kind,
  digest: kind === 'contribution' ? contributionDigest : corpusDigest }) });
const request = (body: unknown) => new Request('https://app.example/api/operator/expert-reviews', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
function contributionBody() {
  return { snapshotDigest: reviewDigest(contributionSnapshot), attestation: true,
    review: { contributionId: contribution.id, reviewedAt: timestamp, qualificationsVerified: true, consentVerified: true,
      conflictOfInterestCleared: true, approvedAnswers: [{ caseId: 'case-one', exactAnswer: 'Paris',
        rationale: 'Retained evidence independently checked', evidenceSourceIds: ['source-one'] }] } };
}
function corpusBody() {
  const reviewed = structuredClone(candidates);
  reviewed.sources[0].review = { status: 'approved', reviewerId: '', reviewedAt: timestamp, notes: 'License and evidence reviewed' };
  reviewed.cases[0].verification = { status: 'approved', method: 'independent_evidence', verifierId: '',
    independentOfTarget: true, independentOfGenerator: true, evidenceSourceIds: ['source-one'], reviewedAnswer: 'Paris',
    reviewedAt: timestamp, rationale: 'Retained source supports exact answer' };
  return { snapshotDigest: reviewDigest(corpusSnapshot), attestation: true, decision: 'approved', reviewed };
}
function rawSql() {
  // Same actual pool transaction adapter as the application, with this test's local SQL transport.
  const pool = { async query(sql: string, params: unknown[] = []) { return state.pg.query(sql, params); },
    async connect() { return { query: (sql: string, params: unknown[] = []) => state.pg.query(sql, params), release() {} }; } };
  return pooledCalendarDatabase(pool);
}
function operations(id = jobId) {
  return createPostgresDataOperationLedger(rawSql(), { tenantId, jobId: id, ownerId: 'data_service_v1',
    authenticateOwner: async () => ({ ownerId: 'data_service_v1' }), knownSecrets: [] });
}
async function seedOperation(key: string, value: unknown, id = jobId) {
  const ledger = operations(id); const digest = reviewDigest(value);
  await ledger.claim(key, digest); await ledger.complete(key, digest, value);
}
async function completedAuthorityRows() {
  return (await state.pg.query(`SELECT operation_key,state FROM evaluation_data_persistence.operations
    WHERE operation_key=$1 AND state='complete'`, [`authenticated-data-review:${corpusDigest}`])).rows;
}

beforeEach(async () => {
  state.pg = new PGlite(); state.afterQuery = undefined; state.queries = [];
  state.viewer = { id: principalId, email: 'operator@example.org', isOperator: true };
  process.env.EVAL_SERVICES = 'real'; process.env.DATABASE_URL = 'postgres://offline-sql-review';
  await state.pg.exec(`CREATE TABLE public.customers(id uuid PRIMARY KEY,email text NOT NULL);
    CREATE TABLE public.jobs(id uuid PRIMARY KEY,customer_id uuid NOT NULL REFERENCES customers(id),package text NOT NULL,
      environment text NOT NULL,is_mock boolean NOT NULL,retest_of_job_id uuid,state text NOT NULL);
    CREATE TABLE public.job_credentials(job_id uuid PRIMARY KEY REFERENCES jobs(id),ciphertext text NOT NULL);`);
  await state.pg.exec(readFileSync(path.join(stage, 'packages/core/src/db/migrations/0025_expert_workflow.sql'), 'utf8'));
  await state.pg.exec(readFileSync(path.join(stage, 'packages/core/src/evals/data/persistence-migrations/002-data-operations.sql'), 'utf8'));
  await state.pg.query('INSERT INTO customers(id,email) VALUES($1,$2),($3,$4)', [tenantId,'tenant@example.org',principalId,'operator@example.org']);
  await state.pg.query(`INSERT INTO jobs(id,customer_id,package,environment,is_mock,state)
    VALUES($1,$2,'text_eval','test',false,'planning'),($3,$2,'text_eval','test',false,'planning')`, [jobId,tenantId,otherJobId]);
  for (const id of [jobId, otherJobId]) {
    const input = { task: { ...task, jobId: id }, initial: candidates, context: { versionLabel: 'baseline', systemPrompt: 'Answer factual questions.' } };
    await state.pg.query(`INSERT INTO expert_workflow.plans(job_id,tenant_id,input,input_digest,topic,enabled,response_deadline)
      VALUES($1,$2,$3::jsonb,$4,'capitals',true,now()+interval '1 day')`, [id,tenantId,JSON.stringify(input),reviewDigest(input)]);
  }
  await seedOperation(`expert-review-candidate:${contributionDigest}`, contributionSnapshot);
  await seedOperation(`data-review-request:${corpusDigest}`, corpusSnapshot);
});
afterEach(async () => { state.afterQuery = undefined; await state.pg.close(); });

describe('real PostgreSQL review handlers, stores, transactions and authority triggers', () => {
  it('writes exact contribution authority and replays immutably through the actual POST', async () => {
    await readExpertWorkflowReview(jobId, 'contribution', contributionDigest, principalId);
    const response = await submit(request(contributionBody()), context('contribution'));
    expect(response.status, JSON.stringify(state.queries)).toBe(200); expect(await response.json()).toEqual({ status: 'recorded' });
    const row = (await state.pg.query(`SELECT job_id,task_id,contribution_digest,reviewer_id,review
      FROM expert_workflow.contribution_reviews WHERE job_id=$1`, [jobId])).rows[0];
    expect(row).toMatchObject({ job_id: jobId, task_id: task.taskId, contribution_digest: contributionDigest, reviewer_id: principalId,
      review: { reviewerId: principalId, contextDigest: contributionDigest, contributionId: contribution.id } });
    const reread = await detail(new Request('https://app.example'), context('contribution'));
    expect(reread.status).toBe(200); expect((await reread.json()).snapshot).toEqual(contributionSnapshot);
    expect((await submit(request(contributionBody()), context('contribution'))).status).toBe(200);
    expect((await state.pg.query('SELECT * FROM expert_workflow.contribution_reviews')).rows).toHaveLength(1);
    const changed = contributionBody(); changed.review.approvedAnswers[0].rationale = 'Different retained review';
    expect((await submit(request(changed), context('contribution'))).status).toBe(409);
    await expect(state.pg.query(`UPDATE expert_workflow.contribution_reviews SET review=review||'{"tampered":true}'::jsonb WHERE job_id=$1`, [jobId])).rejects.toThrow('immutable contribution review');
    await expect(state.pg.query('DELETE FROM expert_workflow.contribution_reviews WHERE job_id=$1', [jobId])).rejects.toThrow('retained expert authority cannot be deleted');
    expect(state.queries.filter(sql => sql === 'COMMIT').length).toBeGreaterThan(0);
  });

  it('retains authenticated corpus receipts with the recomputed exact answer context and real ledger reread', async () => {
    const body = corpusBody();
    expect((await submit(request(body), context('corpus'))).status).toBe(200);
    const record = await operations().get(`authenticated-data-review:${corpusDigest}`);
    expect(record?.state).toBe('complete');
    if (record?.state !== 'complete') throw new Error('missing retained corpus authority');
    const review = record.result as any;
    expect(review).toMatchObject({ authority: 'authenticated_human', principalId, requestDigest: corpusDigest, decision: 'approved' });
    expect(review.data.sources[0].review.reviewerId).toBe(principalId);
    const reviewedCase = review.data.cases[0];
    expect(reviewedCase.verification.verifierId).toBe(principalId);
    expect(reviewedCase.verification.contextDigest).toBe(answerReviewContextDigest(task, reviewedCase, review.data.sources));
    expect(review.data.sources[0].license).toEqual(candidates.sources[0].license);
    const receipt = await operations().get(`data-review-receipt:${review.receiptId}`);
    expect(receipt?.state).toBe('complete'); expect(receipt && receipt.state === 'complete' && receipt.result).toEqual(review);
    const ledger = createAuthenticatedDataReviewLedger({ operations: operations(), authenticateHuman: async () => ({ principalId }) });
    expect(await ledger.readReview({ digest: corpusDigest, task, data: candidates })).toMatchObject({ status: 'decided', review });
    expect((await submit(request(body), context('corpus'))).status).toBe(200);
    await expect(state.pg.query(`UPDATE evaluation_data_persistence.operations SET result='{}'::jsonb WHERE operation_key=$1`,
      [`authenticated-data-review:${corpusDigest}`])).rejects.toThrow('data_operation_immutable');
  });

  it('rolls back an actual contribution INSERT when its awaited completion revokes the principal', async () => {
    let inserted = false;
    state.afterQuery = sql => { if (sql.startsWith('INSERT INTO expert_workflow.contribution_reviews')) { inserted = true; state.viewer = null; } };
    const response = await submit(request(contributionBody()), context('contribution'));
    expect(inserted).toBe(true); expect(response.status).toBe(403);
    expect(state.queries).toContain('ROLLBACK');
    expect((await state.pg.query('SELECT * FROM expert_workflow.contribution_reviews')).rows).toEqual([]);
  });

  it('rolls back a real corpus receipt INSERT after revocation and never publishes corpus authority', async () => {
    let inserted = false;
    state.afterQuery = (sql, params) => {
      if (sql.startsWith('INSERT INTO evaluation_data_persistence.operations') && String(params[2]).startsWith('data-review-receipt:')) {
        inserted = true; state.viewer = null;
      }
    };
    expect((await submit(request(corpusBody()), context('corpus'))).status).toBe(403);
    expect(inserted).toBe(true); expect(state.queries).toContain('ROLLBACK');
    expect(await completedAuthorityRows()).toEqual([]);
    expect((await state.pg.query(`SELECT * FROM evaluation_data_persistence.operations WHERE operation_key LIKE 'data-review-receipt:%'`)).rows).toEqual([]);
  });

  it('rolls back the actual final corpus authority UPDATE after revocation, retaining only an inert receipt', async () => {
    let authorityWrite = false;
    state.afterQuery = (sql, params) => {
      if (sql.startsWith('UPDATE evaluation_data_persistence.operations') && params[2] === `authenticated-data-review:${corpusDigest}`) {
        authorityWrite = true; state.viewer = null;
      }
    };
    expect((await submit(request(corpusBody()), context('corpus'))).status).toBe(403);
    expect(authorityWrite).toBe(true); expect(state.queries).toContain('ROLLBACK');
    expect(await completedAuthorityRows()).toEqual([]);
    const retained = await operations().get(`authenticated-data-review:${corpusDigest}`);
    expect(retained?.state).toBe('pending');
    expect((await state.pg.query(`SELECT * FROM evaluation_data_persistence.operations WHERE operation_key LIKE 'data-review-receipt:%' AND state='complete'`)).rows).toHaveLength(1);
    const ledger = createAuthenticatedDataReviewLedger({ operations: operations(), authenticateHuman: async () => null });
    expect(await ledger.readReview({ digest: corpusDigest, task, data: candidates })).toEqual({ status: 'pending' });
  });

  it('rejects real revoked plans and cross-job snapshots without retaining authority', async () => {
    await state.pg.query('UPDATE expert_workflow.plans SET enabled=false WHERE job_id=$1', [jobId]);
    expect((await submit(request(contributionBody()), context('contribution'))).status).toBe(404);
    await state.pg.query('UPDATE expert_workflow.plans SET enabled=true WHERE job_id=$1', [jobId]);
    await seedOperation(`expert-review-candidate:${contributionDigest}`, contributionSnapshot, otherJobId);
    expect((await submit(request(contributionBody()), context('contribution', otherJobId))).status).toBe(409);
    expect((await state.pg.query('SELECT * FROM expert_workflow.contribution_reviews')).rows).toEqual([]);
    expect(await completedAuthorityRows()).toEqual([]);
  });
});

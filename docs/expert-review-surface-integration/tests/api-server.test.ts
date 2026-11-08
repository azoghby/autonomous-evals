import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ viewer: null as null | { id: string; email: string; isOperator: boolean },
  active: true, operations: new Map<string, any>(), reviews: new Map<string, any>(), queries: [] as string[],
  queueQuery: undefined as undefined | ((query: string, params: readonly any[]) => Promise<{rows: any[]}>),
  onQuery: undefined as undefined | ((query: string, params: readonly unknown[]) => void), inventory: [] as any[],
}));
const db = vi.hoisted(() => ({
  async query(query: string, params: readonly any[] = []): Promise<{ rows: any[] }> {
    state.queries.push(query);
    state.onQuery?.(query, params);
    if (query.includes('SELECT o.job_id,o.operation_key') && state.queueQuery) return state.queueQuery(query, params);
    if (query.includes('SELECT o.job_id,o.operation_key')) return { rows: state.active ? state.inventory.filter(item => !state.reviews.has(`${item.job_id}:${item.operation_key.split(':')[1]}`) && !state.operations.has(`authenticated-data-review:${item.operation_key.split(':')[1]}`)) : [] };
    if (query.startsWith('SELECT customer_id')) return { rows: [{ customer_id: 'tenant-1', package: 'text_eval', environment: 'test', is_mock: false, retest_of_job_id: null }] };
    if (query.includes('SELECT ciphertext')) return { rows: [] };
    if (query.startsWith('SELECT p.input,p.input_digest')) return { rows: state.active ? [{ input: { task }, input_digest: reviewDigest({ task }) }] : [] };
    if (query.startsWith('SELECT 1 FROM jobs')) return { rows: state.active ? [{}] : [] };
    if (query.startsWith('SELECT operation_key, digest')) return { rows: state.operations.has(params[2]) ? [structuredClone(state.operations.get(params[2]))] : [] };
    if (query.startsWith('INSERT INTO evaluation_data_persistence.operations')) {
      if (state.operations.has(params[2])) return { rows: [] };
      const row = { operation_key: params[2], digest: params[3], owner_id: params[4], state: 'pending', result: null, result_digest: null, reconciliation_receipt: null };
      state.operations.set(params[2], row);
      return { rows: [structuredClone(row)] };
    }
    if (query.startsWith('UPDATE evaluation_data_persistence.operations')) {
      const row = state.operations.get(params[2]);
      Object.assign(row, { state: 'complete', result: JSON.parse(params[3]), result_digest: params[4], reconciliation_receipt: params[5] });
      return { rows: [structuredClone(row)] };
    }
    if (query.startsWith('INSERT INTO expert_workflow.contribution_reviews')) {
      const key = `${params[0]}:${params[2]}`;
      if (state.active && !state.reviews.has(key)) state.reviews.set(key, JSON.parse(params[4]));
      return { rows: [] };
    }
    if (query.startsWith('SELECT review FROM expert_workflow.contribution_reviews')) {
      const review = state.reviews.get(`${params[0]}:${params[2]}`);
      return { rows: review ? [{ review: structuredClone(review) }] : [] };
    }
    throw new Error(`Unrecognized test SQL: ${query}`);
  },
  async transaction<T>(fn: (tx: any) => Promise<T>) {
    const operations = structuredClone(state.operations); const reviews = structuredClone(state.reviews);
    try { return await fn(db); } catch (error) { state.operations = operations; state.reviews = reviews; throw error; }
  },
}));
vi.mock('@/server/session', () => ({ getCurrentCustomer: vi.fn(async () => state.viewer && structuredClone(state.viewer)) }));
vi.mock('@neondatabase/serverless', () => ({ Pool: class {} }));
vi.mock('@ae/core/simulator/pool', () => ({ pooledCalendarDatabase: () => db }));
// Unused outbound integrations are fenced. The SQL operation/review ledgers and deterministic validators remain real.
vi.mock('@ae/core/integration/eval-services', () => ({ buildAgentDeps: () => { throw new Error('provider forbidden'); } }));
vi.mock('@/server/automated-expert-owner', () => ({ createOwnerExpertStep: () => { throw new Error('send forbidden'); } }));
vi.mock('@/server/automated-expert-responses', () => ({ createSqlExpertResponseService: () => { throw new Error('provider forbidden'); } }));
vi.mock('@/server/job-store', () => ({ recordCost: () => { throw new Error('cost forbidden'); }, jobKnownCostMicroUsd: () => { throw new Error('cost forbidden'); } }));
import { PGlite } from '@electric-sql/pglite';
import { GET as queue } from '@review-routes/route';
import { GET as detail, POST as submit } from '@review-routes/[jobId]/[kind]/[digest]/route';
import { reviewDigest, answerReviewContextDigest } from '@ae/core/evals/data/binding';
import { expertContributionContextDigest } from '@ae/core/evals/data/expert';
import { dataReviewRequestDigest } from '@ae/core/evals/data/orchestration';

const jobId = '8b1f2b21-a125-4b3e-b234-f828342dd555';
const otherJob = '8b1f2b21-a125-4b3e-b234-f828342dd556';
const principal = '8b1f2b21-a125-4b3e-b234-f828342dd557';
const timestamp = '2026-11-08T12:00:00Z';
const task = { taskId: 'task-1', jobId, description: 'Determine the capital', requirements: [{ id: 'fact', description: 'Capital', minimumCases: 1 }], factualAnswersRequired: true, targetId: 'target-1', requiredUses: ['evaluation'] };
const source = { id: 'source-1', url: 'https://example.org/evidence', content: 'Paris is the capital of France.',
  license: { name: 'CC0', url: 'https://example.org/license', permission: 'allowed', allowedUses: ['evaluation'] },
  provenance: { origin: 'expert', producerId: 'contributor-1', retrievedAt: timestamp, contentHash: 'evidence-hash' },
  review: { status: 'pending', reviewerId: '', reviewedAt: timestamp, notes: '' } };
const candidate = { id: 'case-1', input: 'Capital of France?', requirementIds: ['fact'], synthetic: false, generatorId: 'contributor-1', sourceIds: ['source-1'], expectedAnswer: 'Paris' };
let snapshot: any;
let key: string;
let kind: 'contribution' | 'corpus';
function retain(value: any, selected: 'contribution' | 'corpus' = 'contribution') {
  snapshot = structuredClone(value); kind = selected;
  key = selected === 'contribution' ? expertContributionContextDigest(snapshot.task, snapshot.contribution) : dataReviewRequestDigest(snapshot.task, snapshot.candidates);
  const operation_key = `${selected === 'contribution' ? 'expert-review-candidate' : 'data-review-request'}:${key}`;
  state.operations.set(operation_key, { operation_key, digest: reviewDigest(snapshot), owner_id: 'data_service_v1', state: 'complete', result: structuredClone(snapshot), result_digest: reviewDigest(snapshot), reconciliation_receipt: null });
  state.inventory = [{ job_id: jobId, operation_key }];
}
const context = (id = jobId) => ({ params: Promise.resolve({ jobId: id, kind, digest: key }) });
function postBody(extra: any = {}) {
  if (kind === 'corpus') {
    const reviewed = structuredClone(snapshot.candidates);
    reviewed.sources[0].review = { status: 'approved', reviewerId: '', reviewedAt: timestamp, notes: 'Permission and integrity checked' };
    reviewed.cases[0].verification = { status: 'approved', method: 'independent_evidence', verifierId: '', independentOfTarget: true, independentOfGenerator: true,
      evidenceSourceIds: ['source-1'], reviewedAnswer: 'Paris', reviewedAt: timestamp, rationale: 'Retained evidence supports this answer.' };
    return { snapshotDigest: reviewDigest(snapshot), attestation: true, decision: 'approved', reviewed, ...extra };
  }
  return { snapshotDigest: reviewDigest(snapshot), attestation: true, review: { contributionId: 'contribution-1', reviewedAt: timestamp,
    qualificationsVerified: true, consentVerified: true, conflictOfInterestCleared: true,
    approvedAnswers: [{ caseId: 'case-1', exactAnswer: 'Paris', rationale: 'Evidence checked', evidenceSourceIds: ['source-1'] }] }, ...extra };
}
function request(body: any, headers = {}) { return new Request('https://app.example/api/operator/expert-reviews', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }); }
beforeEach(() => {
  state.viewer = { id: principal, email: 'operator@example.org', isOperator: true };
  state.active = true; state.operations.clear(); state.reviews.clear(); state.queries = []; state.onQuery = undefined; state.queueQuery = undefined;
  process.env.EVAL_SERVICES = 'real'; process.env.DATABASE_URL = 'postgres://offline-test'; delete process.env.REVIEW_ROTATED_SECRET;
  retain({ task, contribution: { id: 'contribution-1', taskId: 'task-1', contributorId: 'contributor-1',
    consent: { evaluation: true, allowedUses: ['evaluation'], receiptUrl: 'https://example.org/consent' }, qualificationEvidence: ['Domain qualification verified'], cases: [candidate], sources: [source] } });
});
describe('actual expert-review handlers with real review validators', () => {
  it('executes the actual queue SQL in PostgreSQL and excludes terminal reviews/currently unauthorized scopes', async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`CREATE SCHEMA evaluation_data_persistence; CREATE SCHEMA expert_workflow;
        CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,package text,is_mock boolean,state text);
        CREATE TABLE expert_workflow.plans(job_id uuid,tenant_id uuid,enabled boolean,response_deadline timestamptz);
        CREATE TABLE evaluation_data_persistence.operations(tenant_id text,job_id text,operation_key text,state text);
        CREATE TABLE expert_workflow.contribution_reviews(job_id uuid,contribution_digest text);`);
      const tenantId = '8b1f2b21-a125-4b3e-b234-f828342dd558';
      await pg.query(`INSERT INTO jobs VALUES($1,$2,'text_eval',false,'planning')`, [jobId,tenantId]);
      await pg.query(`INSERT INTO expert_workflow.plans VALUES($1,$2,true,now()+interval '1 day')`, [jobId,tenantId]);
      await pg.query(`INSERT INTO evaluation_data_persistence.operations VALUES($1,$2,$3,'complete')`, [tenantId,jobId,`expert-review-candidate:${key}`]);
      state.queueQuery = (query, params) => pg.query(query, [...params]);
      expect((await (await queue()).json()).items).toHaveLength(1);
      const invalid = Array.from({length: 100}, (_,index)=>`expert-review-candidate:${index.toString(16).padStart(64,'0')}`);
      for (const operation of invalid) await pg.query(`INSERT INTO evaluation_data_persistence.operations VALUES($1,$2,$3,'complete')`,[tenantId,jobId,operation]);
      const firstPage = await (await queue()).json();
      expect(firstPage.items).toEqual([]); expect(firstPage.scanned).toBe(100); expect(firstPage.nextCursor).toEqual(expect.any(String));
      const secondPage = await (await queue(new Request(`https://app.example/api/operator/expert-reviews?cursor=${firstPage.nextCursor}`))).json();
      expect(secondPage.items).toHaveLength(1); expect(secondPage.nextCursor).toBeNull();
      await pg.query(`DELETE FROM evaluation_data_persistence.operations WHERE operation_key=ANY($1::text[])`,[invalid]);
      await pg.query('INSERT INTO expert_workflow.contribution_reviews VALUES($1,$2)', [jobId,key]);
      expect((await (await queue()).json()).items).toEqual([]);
      await pg.query('DELETE FROM expert_workflow.contribution_reviews');
      await pg.query('UPDATE expert_workflow.plans SET enabled=false');
      expect((await (await queue()).json()).items).toEqual([]);
      await pg.query('UPDATE expert_workflow.plans SET enabled=true');
      retain({ task, candidates: { cases: [candidate], sources: [source] } }, 'corpus');
      await pg.query('DELETE FROM evaluation_data_persistence.operations');
      await pg.query(`INSERT INTO evaluation_data_persistence.operations VALUES($1,$2,$3,'complete'),($1,$2,$4,'complete')`,
        [tenantId,jobId,`data-review-request:${key}`,`authenticated-data-review:${key}`]);
      expect((await (await queue()).json()).items).toEqual([]);
    } finally { await pg.close(); }
  });
  it('rejects malformed cursors and unexpected queue selectors without broadening scope', async () => {
    for (const query of ['cursor=invalid','cursor='+ 'a'.repeat(301),'customer=someone','cursor=x&cursor=y'])
      expect((await queue(new Request('https://app.example/api/operator/expert-reviews?'+query))).status).toBe(400);
  });
  it('requires a real operator session for every route and uses private no-store on denial', async () => {
    state.viewer = null;
    for (const result of [await queue(), await detail(new Request('https://app.example'), context()), await submit(request(postBody()), context())]) {
      expect(result.status).toBe(401); expect(result.headers.get('cache-control')).toContain('private, no-store');
    }
    state.viewer = { id: 'model', email: 'model@example.org', isOperator: false };
    expect((await queue()).status).toBe(403); expect(state.queries).toHaveLength(0);
  });
  it('loads exact scoped snapshots and canonical authorized inventory', async () => {
    const result = await queue(); expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ items: [{ jobId, kind, digest: key, taskId: 'task-1' }], truncated: false, scanned: 1, nextCursor: null });
    expect(state.queries[0]).toContain('j.customer_id::text=o.tenant_id'); expect(state.queries[0]).toContain('p.tenant_id=j.customer_id');
    const result2 = await detail(new Request('https://app.example'), context());
    expect(result2.headers.get('cache-control')).toContain('private, no-store');
    expect(await result2.json()).toEqual({ kind, jobId, digest: key, snapshotDigest: reviewDigest(snapshot), snapshot, principalId: principal });
  });
  it('denies a same-job snapshot for a task outside the canonical plan', async () => {
    const changed = structuredClone(snapshot); changed.task.description = 'Different authorized task'; retain(changed);
    expect((await submit(request(postBody()), context())).status).toBe(409); expect(state.reviews.size).toBe(0);
  });
  it('records only exact independent contribution review with server principal and context', async () => {
    const result = await submit(request(postBody()), context()); expect(result.status).toBe(200);
    expect(state.reviews.get(`${jobId}:${key}`)).toMatchObject({ reviewerId: principal, contextDigest: key });
    expect(state.queries.find(q => q.startsWith('INSERT INTO expert_workflow'))).toContain('p.enabled');
    expect((await submit(request(postBody()), context())).status).toBe(200);
  });
  it('rejects stale client snapshot and modified immutable stored snapshot', async () => {
    expect((await submit(request(postBody({ snapshotDigest: '0'.repeat(64) })), context())).status).toBe(409);
    const record = state.operations.values().next().value!; record.result.contribution.cases[0].expectedAnswer = 'Changed';
    record.result_digest = reviewDigest(record.result); record.digest = reviewDigest(record.result);
    expect((await submit(request(postBody()), context())).status).toBe(409); expect(state.reviews.size).toBe(0);
  });
  it('denies cross-job snapshots', async () => {
    expect((await detail(new Request('https://app.example'), context(otherJob))).status).toBe(409);
    expect((await submit(request(postBody()), context(otherJob))).status).toBe(409); expect(state.reviews.size).toBe(0);
  });
  it('fences principal revocation or switch during the awaited candidate read', async () => {
    for (const next of [null, { id: 'different-human', email: 'other@example.org', isOperator: true }]) {
      state.viewer = { id: principal, email: 'operator@example.org', isOperator: true };
      state.onQuery = query => { if (query.startsWith('SELECT operation_key, digest')) state.viewer = next; };
      expect((await submit(request(postBody()), context())).status).toBe(403);
    }
    expect(state.reviews.size).toBe(0); expect(state.queries.some(q => q.startsWith('INSERT'))).toBe(false);
  });
  it('rolls back contribution authority when the session is revoked during its awaited write', async () => {
    state.onQuery = query => { if (query.startsWith('INSERT INTO expert_workflow.contribution_reviews')) state.viewer = null; };
    expect((await submit(request(postBody()), context())).status).toBe(403);
    expect(state.reviews.size).toBe(0);
  });
  it('denies plan revocation and current secret rotation after a snapshot read', async () => {
    state.onQuery = query => { if (query.startsWith('SELECT operation_key, digest')) state.active = false; };
    expect((await submit(request(postBody()), context())).status).toBe(404); expect(state.reviews.size).toBe(0);
    state.active = true;
    state.onQuery = query => { if (query.startsWith('SELECT operation_key, digest')) process.env.REVIEW_ROTATED_SECRET = 'Domain qualification verified'; };
    expect((await detail(new Request('https://app.example'), context())).status).toBe(404);
  });
  it('bounds streamed JSON and rejects malformed/forged attestations', async () => {
    expect((await submit(request(' '.repeat(450_001)), context())).status).toBe(413);
    expect((await submit(request('{'), context())).status).toBe(400);
    expect((await submit(request(postBody({ attestation: false })), context())).status).toBe(400);
    const forged = postBody(); forged.review.reviewerId = 'model';
    expect((await submit(request(forged), context())).status).toBe(400);
    expect((await submit(request(postBody(), { origin: 'https://attacker.example' }), context())).status).toBe(403);
    expect(state.reviews.size).toBe(0);
  });
  it('rejects non-independent contribution answers and false qualification checks', async () => {
    const body = postBody(); body.review.approvedAnswers[0].exactAnswer = 'Wrong';
    expect((await submit(request(body), context())).status).toBe(422);
    const body2 = postBody(); body2.review.qualificationsVerified = false;
    expect((await submit(request(body2), context())).status).toBe(422); expect(state.reviews.size).toBe(0);
  });
  it('records exact corpus review, recomputes answer binding, and uses immutable authenticated receipts', async () => {
    retain({ task, candidates: { cases: [candidate], sources: [source] } }, 'corpus');
    const body = postBody(); const result = await submit(request(body), context()); expect(result.status).toBe(200);
    const retained = state.operations.get(`authenticated-data-review:${key}`)?.result;
    expect(retained).toMatchObject({ authority: 'authenticated_human', principalId: principal, requestDigest: key, decision: 'approved' });
    expect(retained.data.sources[0].review.reviewerId).toBe(principal);
    expect(retained.data.cases[0].verification.verifierId).toBe(principal);
    expect(retained.data.cases[0].verification.contextDigest).toBe(answerReviewContextDigest(task, retained.data.cases[0], retained.data.sources));
    expect((await submit(request(body), context())).status).toBe(200);
  });
  it('preserves corpus payload, license restrictions, source identities, and expert authority', async () => {
    retain({ task, candidates: { cases: [candidate], sources: [source] } }, 'corpus');
    for (const mutate of [
      (b: any) => { b.reviewed.cases[0].expectedAnswer = 'Changed'; },
      (b: any) => { b.reviewed.sources[0].license.allowedUses.push('redistribution'); },
      (b: any) => { b.reviewed.sources.push({ ...source, id: 'new-source' }); },
      (b: any) => { b.reviewed.cases[0].verification.expertAttestation = { qualified: true, consentToEvaluation: true, contributionId: 'forged' }; },
    ]) {
      const body = postBody(); mutate(body);
      expect((await submit(request(body), context())).status).toBe(409);
    }
    expect(state.operations.has(`authenticated-data-review:${key}`)).toBe(false);
  });
  it('reauthenticates between corpus receipt writes after an operation await', async () => {
    retain({ task, candidates: { cases: [candidate], sources: [source] } }, 'corpus');
    state.onQuery = query => { if (query.startsWith('UPDATE evaluation_data_persistence.operations')) state.viewer = null; };
    expect((await submit(request(postBody()), context())).status).toBe(403);
    expect(state.operations.has(`authenticated-data-review:${key}`)).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTransactionalSql } from '../../agents/postgres-ports';
import { acquireEvaluationData, type EvaluationDataTask, type EvaluationDataPorts } from './acquisition';
import { answerReviewContextDigest, reviewDigest } from './binding';
import { assessDataQuality } from './quality';
import { createPostgresEvaluationDataStore } from './postgres-store';

const migration = readFileSync(new URL('./persistence-migrations/001-evaluation-data.sql', import.meta.url), 'utf8');
const at = '2026-11-07T12:00:00Z';
const scope = { tenantId: 'tenant', jobId: 'job' };
function fixture(): EvaluationDataTask {
  const spec = { taskId: 'task', jobId: 'job', description: 'Arithmetic', requirements: [{ id: 'addition', description: 'Addition', minimumCases: 1 }], factualAnswersRequired: true, targetId: 'target' };
  return { taskId: spec.taskId, revision: 0, spec, requestHash: createHash('sha256').update(JSON.stringify({ spec, initial: { sources: [], cases: [] } })).digest('hex'),
    state: 'acquiring', phase: 'discovery', sources: [], cases: [], assessment: assessDataQuality(spec, [], []),
    decisions: [{ id: 'initial', phase: 'discovery', outcome: 'unassessed', at }], updatedAt: at };
}
const advance = (r: EvaluationDataTask): EvaluationDataTask => ({ ...structuredClone(r), revision: r.revision + 1 });

describe('PostgreSQL evaluation data (actual PGlite SQL, serialized single engine)', () => {
  let engine: PGlite;
  let db: AgentTransactionalSql;
  let store: ReturnType<typeof createPostgresEvaluationDataStore>;
  beforeEach(async () => {
    engine = new PGlite(); await engine.exec(migration);
    db = { query: (sql, params) => engine.query(sql, params), transaction: fn => engine.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params) })) };
    store = createPostgresEvaluationDataStore(db, scope);
  });
  afterEach(async () => { await engine.close(); });

  it('persists definitive discovery rejection and resumes generation/expert through fresh SQL adapters', async () => {
    const discover = vi.fn(async () => ({ status: 'rejected' as const, rejection: { reasons: ['pii_detected' as const] } }));
    const generate = vi.fn(async () => ({ status: 'complete' as const, data: { sources: [], cases: [] } }));
    const expert = vi.fn(async () => ({ status: 'pending' as const }));
    const run = () => acquireEvaluationData(fixture().spec, { sources: [], cases: [] }, {
      store: createPostgresEvaluationDataStore(db, scope), discover, generate, expert, now: () => new Date(at),
    });
    const rejected = await run();
    expect(rejected.phase).toBe('generation');
    expect(rejected.decisions.at(-1)).toMatchObject({ phase: 'discovery', outcome: 'discovery_rejected', rejection: { reasons: ['pii_detected'] } });
    expect((await run()).phase).toBe('expert');
    expect((await run()).state).toBe('waiting_for_expert');
    expect(discover).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1); expect(expert).toHaveBeenCalledTimes(1);
    expect((await store.get('task'))?.sources).toEqual([]);
  });

  it('replays from independent service instances with detached input and outputs', async () => {
    const input = fixture();
    const inserted = await store.insertIfAbsent(input);
    input.spec.description = 'changed'; inserted.record.spec.description = 'changed';
    const fresh = createPostgresEvaluationDataStore(db, scope);
    expect(await fresh.get('task')).toEqual(fixture());
    const replay = await fresh.insertIfAbsent(fixture());
    expect(replay).toEqual({ inserted: false, record: fixture() });
    replay.record.decisions.length = 0;
    expect((await fresh.get('task'))?.decisions).toHaveLength(1);
  });
  it('has one insert and one CAS winner across concurrent callers (PGlite serializes transactions)', async () => {
    const claimants = Array.from({ length: 8 }, () => createPostgresEvaluationDataStore(db, scope));
    const inserts = await Promise.all(claimants.map(s => s.insertIfAbsent(fixture())));
    expect(inserts.filter(x => x.inserted)).toHaveLength(1);
    const results = await Promise.all(claimants.map(s => s.compareAndSet('task', 0, advance(fixture()))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.get('task'))?.revision).toBe(1);
  });
  it('isolates reads, inserts and CAS by both trusted tenant and job', async () => {
    await store.insertIfAbsent(fixture());
    for (const otherScope of [{ ...scope, tenantId: 'other' }, { ...scope, jobId: 'other' }]) {
      const other = createPostgresEvaluationDataStore(db, otherScope);
      expect(await other.get('task')).toBeNull();
      const r = fixture(); r.spec.jobId = otherScope.jobId;
      expect(await other.compareAndSet('task', 0, advance(r))).toBeNull();
      expect((await other.insertIfAbsent(r)).inserted).toBe(true);
      expect(await other.compareAndSet('task', 0, advance(r))).not.toBeNull();
    }
    expect(await store.get('task')).toEqual(fixture());
  });
  it('captures scope values at construction and rejects record job mismatch', async () => {
    const config = { ...scope }; const scoped = createPostgresEvaluationDataStore(db, config);
    config.jobId = 'other'; config.tenantId = 'other';
    await scoped.insertIfAbsent(fixture()); expect(await store.get('task')).not.toBeNull();
    const wrong = fixture(); wrong.spec.jobId = 'other';
    await expect(store.insertIfAbsent(wrong)).rejects.toThrow('invalid');
    await expect(store.compareAndSet('task', 0, advance(wrong))).rejects.toThrow('invalid');
  });
  it.each(['hash', 'description', 'target', 'coverage', 'uses', 'factual'] as const)('rejects insert and CAS identity drift: %s', async field => {
    await store.insertIfAbsent(fixture()); const drift = fixture();
    if (field === 'hash') drift.requestHash = 'b'.repeat(64);
    if (field === 'description') drift.spec.description = 'Different';
    if (field === 'target') drift.spec.targetId = 'different';
    if (field === 'coverage') drift.spec.requirements[0]!.minimumCases = 2;
    if (field === 'uses') drift.spec.requiredUses = ['redistribution'];
    if (field === 'factual') drift.spec.factualAnswersRequired = false;
    await expect(store.insertIfAbsent(drift)).rejects.toThrow('identity_conflict');
    await expect(store.compareAndSet('task', 0, advance(drift))).rejects.toThrow('identity_conflict');
    expect(await store.get('task')).toEqual(fixture());
  });
  it('compares full spec canonically after jsonb key reordering', async () => {
    const r = fixture(); r.spec = Object.fromEntries(Object.entries(r.spec).reverse()) as typeof r.spec;
    await store.insertIfAbsent(r);
    expect((await store.insertIfAbsent(fixture())).inserted).toBe(false);
    expect(await store.compareAndSet('task', 0, advance(fixture()))).not.toBeNull();
  });
  it('returns null for missing/stale revisions and rejects invalid revisions and history loss', async () => {
    expect(await store.compareAndSet('task', 0, advance(fixture()))).toBeNull();
    await store.insertIfAbsent(fixture());
    await store.compareAndSet('task', 0, advance(fixture()));
    expect(await store.compareAndSet('task', 0, advance(fixture()))).toBeNull();
    await expect(store.compareAndSet('task', -1, fixture())).rejects.toThrow('invalid');
    await expect(store.compareAndSet('task', 1, advance(fixture()))).rejects.toThrow('invalid');
    const next = advance(advance(fixture())); next.decisions = [];
    await expect(store.compareAndSet('task', 1, next)).rejects.toThrow('invalid');
  });
  it.each([NaN, Infinity, undefined, '\u0000', '\ud800', '\udc00', new Date(), () => 'hidden'])('rejects non-JSON/unsafe text %# without changing storage', async value => {
    const r = fixture(); (r.spec as unknown as Record<string, unknown>).description = value;
    await expect(store.insertIfAbsent(r)).rejects.toThrow('invalid');
    expect(await store.get('task')).toBeNull();
  });
  it('rejects accessors, custom serialization, sparse arrays, symbols and cycles', async () => {
    const accessor = fixture(); let calls = 0;
    Object.defineProperty(accessor.spec, 'description', { enumerable: true, get() { calls++; return 'x'; } });
    const custom = fixture(); Object.assign(custom.spec, { toJSON() { calls++; return {}; } });
    const sparse = fixture(); sparse.decisions = new Array(2);
    const symbolic = fixture(); Object.assign(symbolic, { [Symbol('hidden')]: true });
    const cyclic = fixture(); Object.assign(cyclic, { cycle: cyclic });
    const rootAccessor = fixture(); Object.defineProperty(rootAccessor, 'taskId', { enumerable: true, get() { calls++; return 'task'; } });
    for (const r of [accessor, custom, sparse, symbolic, cyclic, rootAccessor]) await expect(store.insertIfAbsent(r)).rejects.toThrow('invalid');
    expect(calls).toBe(0);
  });
  it('accepts valid Unicode and SQL-shaped text as bound data', async () => {
    const r = fixture(); r.spec.description = "🧪 é '); DROP TABLE tasks; --";
    await store.insertIfAbsent(r); expect(await store.get('task')).toEqual(r);
    await expect(store.get("' OR true --")).rejects.toThrow('invalid');
  });
  it('bounds serialized record bytes', async () => {
    const r = fixture(); r.spec.description = '🧪'.repeat(130_000);
    await expect(store.insertIfAbsent(r)).rejects.toThrow('invalid');
    expect(await store.get('task')).toBeNull();
  });
  it.each(['nested', 'unknown', 'revision', 'task', 'job', 'enum'] as const)('rejects malformed stored row: %s', async kind => {
    const r: any = fixture();
    if (kind === 'nested') r.sources = [{ id: 'broken' }];
    if (kind === 'unknown') r.assessment.extra = 'hidden';
    if (kind === 'revision') r.revision = 1;
    if (kind === 'task') r.taskId = 'other';
    if (kind === 'job') r.spec.jobId = 'other';
    if (kind === 'enum') r.phase = 'unsafe';
    // Deliberately bypass migration checks to exercise adapter defense against legacy/corrupt rows.
    const corrupt: AgentTransactionalSql = { query: async <T>() => ({ rows: [{ record: r, revision: '0' }] as T[] }), transaction: db.transaction };
    await expect(createPostgresEvaluationDataStore(corrupt, scope).get('task')).rejects.toThrow('invalid');
  });
  it('rejects actual database rows with malformed nested JSON on read, insert replay and CAS', async () => {
    await store.insertIfAbsent(fixture());
    await engine.query("UPDATE evaluation_data_persistence.tasks SET record = jsonb_set(record, '{cases}', '[{}]'::jsonb)");
    await expect(store.get('task')).rejects.toThrow('invalid');
    await expect(store.insertIfAbsent(fixture())).rejects.toThrow('invalid');
    await expect(store.compareAndSet('task', 0, advance(fixture()))).rejects.toThrow('invalid');
  });
  it('screens current secret policy on reads, conflicting inserts and CAS', async () => {
    const r = fixture(); r.spec.description = 'opaque-confidential-fixture';
    await store.insertIfAbsent(r);
    const secrets: string[] = [];
    const updated = createPostgresEvaluationDataStore(db, { ...scope, knownSecrets: () => secrets });
    expect(await updated.get('task')).toEqual(r);
    secrets.push(r.spec.description);
    await expect(updated.get('task')).rejects.toThrow('invalid');
    await expect(updated.insertIfAbsent(r)).rejects.toThrow('invalid');
    await expect(updated.compareAndSet('task', 0, advance(r))).rejects.toThrow('invalid');
    const fresh = createPostgresEvaluationDataStore(db, { ...scope, knownSecrets: secrets });
    await expect(fresh.get('task')).rejects.toThrow('invalid');
    expect(await store.get('task')).toEqual(r);
  });
  it('rolls back inserts and CAS when the returned row fails validation', async () => {
    let corruptInsert = true;
    const faulty: AgentTransactionalSql = { query: db.query, transaction: fn => db.transaction(tx => fn({
      async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        if (sql.includes('RETURNING') && (sql.startsWith('UPDATE') || corruptInsert)) return { rows: [{ record: {}, revision: 0 }] as T[] };
        return result;
      },
    })) };
    const broken = createPostgresEvaluationDataStore(faulty, scope);
    await expect(broken.insertIfAbsent(fixture())).rejects.toThrow('invalid');
    expect(await store.get('task')).toBeNull();
    corruptInsert = false; await broken.insertIfAbsent(fixture());
    await expect(broken.compareAndSet('task', 0, advance(fixture()))).rejects.toThrow('invalid');
    expect(await store.get('task')).toEqual(fixture());
  });
  it('rolls back when the current secret policy changes before RETURNING is validated', async () => {
    const secrets: string[] = [];
    const observed: AgentTransactionalSql = { query: db.query, transaction: fn => db.transaction(tx => fn({
      async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        if (sql.startsWith('INSERT')) secrets.push('Arithmetic');
        return result;
      },
    })) };
    const updated = createPostgresEvaluationDataStore(observed, { ...scope, knownSecrets: () => secrets });
    await expect(updated.insertIfAbsent(fixture())).rejects.toThrow('invalid');
    expect(await store.get('task')).toBeNull();
  });
  it('redacts driver failure text with no transaction retries', async () => {
    const transaction = vi.fn(async () => { throw new Error('opaque-sensitive-parameter'); });
    const bad: AgentTransactionalSql = { query: async () => { throw new Error('opaque-sensitive-parameter'); }, transaction };
    const failed = createPostgresEvaluationDataStore(bad, scope);
    await expect(failed.get('task')).rejects.toThrow(/^evaluation_data_persistence_failed$/);
    await expect(failed.insertIfAbsent(fixture())).rejects.toThrow(/^evaluation_data_persistence_failed$/);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it('preserves complete bound review evidence and decision history across restart', async () => {
    const r = fixture();
    r.cases = [{ id: 'case', input: 'What is two plus two?', expectedAnswer: 'Four', synthetic: true, generatorId: 'generator', requirementIds: ['addition'], sourceIds: [],
      verification: { status: 'approved', method: 'expert', verifierId: 'expert', independentOfTarget: true, independentOfGenerator: true, evidenceSourceIds: [], reviewedAnswer: 'Four', reviewedAt: at, rationale: 'Independent calculation',
        expertAttestation: { qualified: true, consentToEvaluation: true, contributionId: 'contribution', contributionContextDigest: reviewDigest({ consent: true, qualifications: 'math' }) } } }];
    r.sources = [{ id: 'evidence', url: 'https://example.org/arithmetic', content: 'Two plus two is four',
      license: { name: 'CC0', url: 'https://example.org/license', permission: 'allowed', allowedUses: ['evaluation'] },
      provenance: { origin: 'expert', producerId: 'independent-author', retrievedAt: at, contentHash: createHash('sha256').update('Two plus two is four').digest('hex') },
      review: { status: 'approved', reviewerId: 'independent-reviewer', reviewedAt: at, notes: 'Reviewed evidence and permission' } }];
    r.cases[0]!.sourceIds = ['evidence'];
    r.cases[0]!.verification!.evidenceSourceIds = ['evidence'];
    r.cases[0]!.verification!.contextDigest = answerReviewContextDigest(r.spec, r.cases[0]!, r.sources);
    r.assessment = assessDataQuality(r.spec, r.cases, r.sources); r.state = 'ready'; r.phase = 'complete';
    expect(r.assessment.status).toBe('sufficient');
    await store.insertIfAbsent(r);
    const next = advance(r); next.decisions.push({ id: 'reviewed', phase: 'expert', outcome: 'sufficient', at });
    await store.compareAndSet('task', 0, next);
    expect(await createPostgresEvaluationDataStore(db, scope).get('task')).toEqual(next);
  });
  it('resumes acquisition with the same operation key after restart, outside any SQL transaction', async () => {
    let active = false;
    const observed: AgentTransactionalSql = { query: db.query, transaction: fn => db.transaction(async tx => { active = true; try { return await fn(tx); } finally { active = false; } }) };
    const keys: string[] = [];
    const provider: EvaluationDataPorts['discover'] = async request => { expect(active).toBe(false); keys.push(request.operationKey); return { status: 'pending' }; };
    const ports = (): EvaluationDataPorts => ({ store: createPostgresEvaluationDataStore(observed, scope), discover: provider, generate: provider, expert: provider, now: () => new Date(at) });
    const first = await acquireEvaluationData(fixture().spec, { sources: [], cases: [] }, ports());
    const resumed = await acquireEvaluationData(fixture().spec, { sources: [], cases: [] }, ports());
    expect(first.state).toBe('waiting_for_data'); expect(resumed.revision).toBe(2);
    expect(resumed.decisions).toEqual(first.decisions); expect(keys[0]).toBe(keys[1]);
    const drift = fixture().spec; drift.targetId = 'changed';
    await expect(acquireEvaluationData(drift, { sources: [], cases: [] }, ports())).rejects.toThrow('identity conflict');
    await expect(acquireEvaluationData(fixture().spec, { sources: [], cases: [{ id: 'case', input: 'drift', requirementIds: ['addition'], synthetic: true, generatorId: 'generator', sourceIds: [] }] }, ports())).rejects.toThrow('identity conflict');
    expect(keys).toHaveLength(2);
  });
  it('replays only correctly bound ready acquisition data after service restart', async () => {
    const r = fixture();
    const provider = vi.fn(async () => ({ status: 'complete' as const, data: { sources: [], cases: [{ id: 'case', input: 'Two plus two?', expectedAnswer: 'Four', synthetic: true, generatorId: 'generator', requirementIds: ['addition'], sourceIds: [] }] } }));
    const ports: EvaluationDataPorts = { store, discover: provider, generate: provider, expert: provider, now: () => new Date(at),
      reviewCandidates: async data => ({ ...data, cases: data.cases.map(candidate => {
        const reviewed = { ...candidate, verification: { status: 'approved' as const, method: 'expert' as const, verifierId: 'expert', independentOfTarget: true, independentOfGenerator: true, evidenceSourceIds: [], reviewedAnswer: 'Four', reviewedAt: at, rationale: 'Calculated independently',
          expertAttestation: { qualified: true, consentToEvaluation: true, contributionId: 'contribution', contributionContextDigest: reviewDigest({ consent: true, qualification: 'arithmetic' }) }, contextDigest: '' } };
        reviewed.verification.contextDigest = answerReviewContextDigest(r.spec, reviewed, data.sources); return reviewed;
      }) }),
    };
    const ready = await acquireEvaluationData(r.spec, { sources: [], cases: [] }, ports);
    expect(ready.state).toBe('ready'); expect(ready.assessment.factualCorrectness).toBe('assessed');
    const restarted = { ...ports, store: createPostgresEvaluationDataStore(db, scope) };
    expect(await acquireEvaluationData(r.spec, { sources: [], cases: [] }, restarted)).toEqual(ready);
    expect(provider).toHaveBeenCalledTimes(1);
    await engine.query("UPDATE evaluation_data_persistence.tasks SET record = jsonb_set(record, '{cases,0,input}', to_jsonb($1::text))", ['Different question']);
    await expect(acquireEvaluationData(r.spec, { sources: [], cases: [] }, restarted)).rejects.toThrow('stale');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('rejects stale ready review bindings and new secret policy before completed replay', async () => {
    const r = fixture(); r.state = 'ready'; r.phase = 'complete';
    r.cases = [{ id: 'case', input: 'opaque-confidential-fixture', synthetic: true, generatorId: 'generator', requirementIds: ['addition'], sourceIds: [] }];
    await store.insertIfAbsent(r);
    const provider = vi.fn(async () => ({ status: 'pending' as const }));
    const ports = { store, discover: provider, generate: provider, expert: provider };
    await expect(acquireEvaluationData(r.spec, { sources: [], cases: [] }, ports)).rejects.toThrow('stale');
    await expect(acquireEvaluationData(r.spec, { sources: [], cases: [] }, { ...ports, store: createPostgresEvaluationDataStore(db, { ...scope, knownSecrets: ['opaque-confidential-fixture'] }) })).rejects.toThrow('invalid');
    expect(provider).not.toHaveBeenCalled();
  });
});

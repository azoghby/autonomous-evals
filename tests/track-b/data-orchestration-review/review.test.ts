// Offline characterization/acceptance only. PGlite runs the actual task-store SQL.
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTransactionalSql } from '../../../agents/postgres-ports';
import { advanceDataOrchestration, dataReviewRequestDigest, type DataOrchestrationPorts } from '../orchestration';
import { createFileDataOperationLedger } from '../operation-ledger';
import { createAuthenticatedDataReviewLedger } from '../review-ledger';
import { createPostgresEvaluationDataStore } from '../postgres-store';
import { answerReviewContextDigest, reviewDigest } from '../binding';
import { assessDataQuality } from '../quality';
import { fixtureCase, fixtureJob, fixtureSource, fixtureSpec } from '../adapters/fixtures';
import type { DataBatch } from '../acquisition';

const roots: string[] = [];
const engines: PGlite[] = [];
afterEach(async () => {
  await Promise.all(engines.splice(0).map(e => e.close()));
  await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true })));
});
async function ledger() {
  const root = await mkdtemp(join(tmpdir(), 'data-review-')); roots.push(root);
  return createFileDataOperationLedger(root);
}
async function sqlStore() {
  const engine = new PGlite(); engines.push(engine);
  await engine.exec(readFileSync(new URL('../persistence-migrations/001-evaluation-data.sql', import.meta.url), 'utf8'));
  const db: AgentTransactionalSql = {
    query: (sql, parameters) => engine.query(sql, parameters),
    transaction: fn => engine.transaction(tx => fn({ query: (sql, parameters) => tx.query(sql, parameters) })),
  };
  return { engine, store: createPostgresEvaluationDataStore(db, { tenantId: 'review-tenant', jobId: fixtureJob.jobId }) };
}
function reviewed(candidates: DataBatch, human = 'review-human'): DataBatch {
  const data = structuredClone(candidates);
  for (const s of data.sources) s.review.reviewerId = human;
  for (const c of data.cases) {
    c.verification = { ...fixtureCase().verification!, verifierId: human };
    c.verification.contextDigest = answerReviewContextDigest(fixtureSpec, c, data.sources);
  }
  return data;
}

describe('independent orchestration review', () => {
  it('CHARACTERIZATION P2: caller initial behavioral synthetic coverage bypasses human intake (actual SQL)', async () => {
    const { store, engine } = await sqlStore(); let reads = 0; let freezes = 0; let providers = 0;
    const spec = { ...fixtureSpec, factualAnswersRequired: false };
    const initial: DataBatch = { sources: [], cases: [{ id: 'behavior', input: 'Return a short greeting', requirementIds: ['export-format'], synthetic: true, generatorId: 'caller-generator', sourceIds: [] }] };
    const ports: DataOrchestrationPorts = {
      operations: await ledger(),
      acquisition: { store, discover: async () => { providers++; return { status: 'pending' }; }, generate: async () => { providers++; return { status: 'pending' }; }, expert: async () => { providers++; return { status: 'pending' }; } },
      readReview: async () => { reads++; return { status: 'pending' }; },
      // Observe invocation only; do not manufacture a successful text-suite service.
      freeze: async () => { freezes++; return { status: 'pending' }; }, deliverCost: async () => {},
    };
    const result = await advanceDataOrchestration(spec, initial, { job: fixtureJob, versionLabel: 'review', systemPrompt: null }, ports);
    expect(result.task.state).toBe('ready'); expect(result.task.assessment.acceptedCaseIds).toEqual(['behavior']);
    expect(reads).toBe(0); expect(providers).toBe(0); expect(freezes).toBe(1);
    expect(result.status).toBe('reconciliation_required'); expect(result.progress.factualCorrectness).toBe('unassessed');
    const rows = await engine.query<{ state: string }>("SELECT record->>'state' AS state FROM evaluation_data_persistence.tasks");
    expect(rows.rows).toEqual([{ state: 'ready' }]);
  });

  it('CHARACTERIZATION P1 conditional: mutable input changes authorized job after authenticateHuman snapshots it', async () => {
    const operations = await ledger(); let release!: () => void; let authenticatedJob = '';
    const gate = new Promise<void>(resolve => { release = resolve; });
    const intake = createAuthenticatedDataReviewLedger({ operations, authenticateHuman: async task => {
      authenticatedJob = task.jobId; await gate;
      return task.jobId === fixtureJob.jobId ? { principalId: 'review-human' } : null;
    } });
    const candidates: DataBatch = { sources: [fixtureSource()], cases: [fixtureCase()] };
    const input = { receiptId: 'scope-race', task: structuredClone(fixtureSpec), candidates, reviewed: reviewed(candidates), decision: 'approved' as const };
    const pending = intake.submit(input);
    input.task.jobId = 'unauthorized-job';
    release(); await pending;
    const digest = dataReviewRequestDigest(input.task, candidates);
    expect(authenticatedJob).toBe(fixtureJob.jobId);
    const receipt = await intake.readReview({ digest, task: input.task, data: candidates });
    expect(receipt.status).toBe('decided');
    if (receipt.status !== 'decided') throw new Error('missing receipt');
    expect(receipt.review.requestDigest).toBe(digest);
    // This demonstrates the immutable authority record itself, not factual admission.
  });

  it('CHARACTERIZATION P2: reviewer-added source can be self-produced and self-reviewed factual evidence', async () => {
    const operations = await ledger();
    const intake = createAuthenticatedDataReviewLedger({ operations, authenticateHuman: async () => ({ principalId: 'review-human' }) });
    const c = fixtureCase(); c.synthetic = true; c.generatorId = 'independent-generator'; c.sourceIds = []; delete c.verification;
    const candidates: DataBatch = { sources: [], cases: [c] };
    const added = fixtureSource(); added.provenance.producerId = 'review-human'; added.review.reviewerId = 'review-human';
    const data = reviewed({ sources: [added], cases: [c] });
    await intake.submit({ receiptId: 'self-source', task: fixtureSpec, candidates, reviewed: data, decision: 'approved' });
    const digest = dataReviewRequestDigest(fixtureSpec, candidates);
    expect((await intake.readReview({ digest, task: fixtureSpec, data: candidates })).status).toBe('decided');
    const assessment = assessDataQuality(fixtureSpec, data.cases, data.sources);
    expect(assessment.status).toBe('sufficient'); expect(assessment.factualCorrectness).toBe('assessed');
    expect(data.sources[0]!.provenance.producerId).toBe(data.cases[0]!.verification!.verifierId);
    const { store, engine } = await sqlStore(); let freezeCalls = 0;
    const result = await advanceDataOrchestration(fixtureSpec, { sources: [], cases: [] },
      { job: fixtureJob, versionLabel: 'review', systemPrompt: null }, {
        operations, acquisition: { store, discover: async () => ({ status: 'complete', data: candidates }),
          generate: async () => { throw new Error('unexpected generation'); }, expert: async () => { throw new Error('unexpected expert'); } },
        readReview: intake.readReview,
        freeze: async () => { freezeCalls++; return { status: 'pending' }; }, deliverCost: async () => {},
      });
    expect(result.task.state).toBe('ready'); expect(result.progress.factualCorrectness).toBe('assessed');
    expect(freezeCalls).toBe(1);
    const persisted = await engine.query<{ factual: string }>("SELECT record->'assessment'->>'factualCorrectness' AS factual FROM evaluation_data_persistence.tasks");
    expect(persisted.rows).toEqual([{ factual: 'assessed' }]);
  });

  it('ACCEPTANCE: authenticated intake rejects the same producer conflict when evidence was already a candidate', async () => {
    const operations = await ledger();
    const intake = createAuthenticatedDataReviewLedger({ operations, authenticateHuman: async () => ({ principalId: 'review-human' }) });
    const s = fixtureSource(); s.provenance.producerId = 'review-human';
    const candidates = { sources: [s], cases: [fixtureCase()] };
    await expect(intake.submit({ receiptId: 'existing-self', task: fixtureSpec, candidates, reviewed: reviewed(candidates), decision: 'approved' })).rejects.toThrow('authorization');
  });

  it('ACCEPTANCE: concurrent file claims have at most one owner and cannot replace immutable completion', async () => {
    const operations = await ledger(); const digest = reviewDigest({ stable: true });
    const claims = await Promise.allSettled(Array.from({ length: 8 }, () => operations.claim('concurrent', digest)));
    expect(claims.filter(r => r.status === 'fulfilled' && r.value.claimed)).toHaveLength(1);
    await operations.complete('concurrent', digest, { status: 'pending' });
    await expect(operations.complete('concurrent', digest, { status: 'changed' })).rejects.toThrow('Immutable');
    expect((await operations.get('concurrent'))?.result).toEqual({ status: 'pending' });
  });
});

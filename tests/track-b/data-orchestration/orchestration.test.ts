// All sources, human receipts, costs and provider responses here are authored offline fixtures.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { advanceDataOrchestration, createDataCostCapture, type DataOrchestrationPorts } from '../orchestration';
import { createAuthenticatedDataReviewLedger } from '../review-ledger';
import { dataReviewRequestDigest } from '../orchestration';
import { createFileDataOperationLedger } from '../operation-ledger';
import { createFileEvaluationDataStore } from '../persistence';
import { answerReviewContextDigest, reviewDigest } from '../binding';
import { fixtureCase, fixtureJob, fixtureSource, fixtureSpec } from '../adapters/fixtures';
import { freezeSuite } from '../../text/freeze';
import type { TextScenario } from '../../text/schema';
import type { AcquisitionRequest, DataBatch } from '../acquisition';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const empty: DataBatch = { sources: [], cases: [] };
const context = { job: fixtureJob, versionLabel: 'fixture-v1', systemPrompt: null };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'data-orchestration-')); directories.push(root);
  let discoverCalls = 0; let generateCalls = 0; let freezeCalls = 0; let reviewPending = false; let costFails = false;
  let operationKey = '';
  const delivered = new Map<string, number>();
  const reopen = () => ({ operations: createFileDataOperationLedger(join(root, 'operations')), store: createFileEvaluationDataStore(join(root, 'tasks')) });
  const durable = reopen();
  const p: DataOrchestrationPorts = {
    operations: durable.operations,
    acquisition: { store: durable.store,
      discover: async () => { discoverCalls++; return { status: 'rejected', rejection: { reasons: ['invalid_response'] } }; },
      generate: async request => {
        generateCalls++; operationKey = request.operationKey;
        await createDataCostCapture(p.operations)({ operationKey, taskKey: 'fixture-generation', cost: { jobId: fixtureJob.jobId, source: 'naive_session', role: 'evaluation_engineer', externalId: 'fixture-session', purpose: 'fixture-generation', microUsd: 17, measured: true, recordedAt: '2026-11-07T00:00:00Z' } });
        const c = fixtureCase(); delete c.verification;
        return { status: 'complete', data: { sources: [], cases: [{ ...c, synthetic: true, generatorId: 'fixture-generator' }] } };
      }, expert: async () => ({ status: 'pending' }),
    },
    readReview: async ({ digest, task, data }) => {
      if (reviewPending) return { status: 'pending' };
      const reviewed = structuredClone(data);
      for (const s of reviewed.sources) { s.license = fixtureSource().license; s.review = { ...fixtureSource().review, reviewerId: 'fixture-human' }; }
      for (const c of reviewed.cases) {
        c.verification = { ...fixtureCase().verification!, verifierId: 'fixture-human' };
        c.verification.contextDigest = answerReviewContextDigest(task, c, reviewed.sources);
      }
      return { status: 'decided', review: { authority: 'authenticated_human', decision: 'approved', principalId: 'fixture-human', receiptId: `receipt_${digest}`, requestDigest: digest, data: reviewed } };
    },
    freeze: async ({ mapping }) => {
      freezeCalls++;
      const scenarios: TextScenario[] = Array.from({ length: 12 }, (_, i) => ({ id: `S${String(i + 1).padStart(2, '0')}`, title: 'Fixture', category: i < 4 ? 'ordinary' : i < 8 ? 'instruction_edge' : 'grounding_ambiguity', userMessage: 'Format?', rationale: 'Authored fixture', severity: 'medium', objectiveChecks: [{ id: `S${String(i + 1).padStart(2, '0')}.o1`, kind: 'objective', description: 'Answer', spec: { type: 'min_chars', value: 1 } }], rubricChecks: [] }));
      return { status: 'complete', suite: freezeSuite({ schemaVersion: 'text_suite.v1', jobId: fixtureJob.jobId, versionLabel: context.versionLabel, frozenAt: '2026-11-07T00:00:00Z', systemPrompt: null, referenceText: mapping.designInput.referenceText, scenarios, review: { sessions: [], rejections: [], reductions: [] } }) };
    },
    deliverCost: async entry => { if (costFails) throw new Error('Private downstream error'); delivered.set(entry.cost.externalId!, entry.cost.microUsd); },
  };
  // Existing public candidate is inadequate until authenticated permission and answer review.
  const initial = { sources: [{ ...fixtureSource(), license: { ...fixtureSource().license, permission: 'unknown' as const, allowedUses: [] } }], cases: [] };
  const advance = () => advanceDataOrchestration(fixtureSpec, initial, context, p);
  return { p, initial, advance, reopen, counts: () => ({ discoverCalls, generateCalls, freezeCalls }), delivered,
    setReviewPending: (v: boolean) => { reviewPending = v; }, setCostFails: (v: boolean) => { costFails = v; }, key: () => operationKey };
}
describe('durable evaluation data coordination', () => {
  it('rejection falls back to generation, resolves permission, freezes approved answers and replays after reopen', async () => {
    const f = await setup();
    expect((await f.advance()).task.phase).toBe('generation');
    const ready = await f.advance();
    expect(ready.status).toBe('ready'); expect(ready.frozen?.suite.referenceText).toContain('JSON');
    expect(ready.frozen?.provenance.cases[0]).toMatchObject({ synthetic: true, generatorId: 'fixture-generator' });
    expect(ready.task.decisions.some(d => d.outcome === 'discovery_rejected')).toBe(true);
    const reopened = f.reopen(); f.p.operations = reopened.operations; f.p.acquisition.store = reopened.store;
    expect((await f.advance()).frozen).toEqual(ready.frozen);
    expect(f.counts()).toEqual({ discoverCalls: 1, generateCalls: 1, freezeCalls: 1 });
    expect([...f.delivered.values()]).toEqual([17]);
  });
  it('retains generated candidates and cost across pending human review without another provider invocation', async () => {
    const f = await setup(); await f.advance(); f.setReviewPending(true);
    expect((await f.advance()).status).toBe('waiting_for_review');
    const reopened = f.reopen(); f.p.operations = reopened.operations; f.p.acquisition.store = reopened.store;
    f.setReviewPending(false); expect((await f.advance()).status).toBe('ready');
    expect(f.counts().generateCalls).toBe(1);
  });
  it('durably captures measured costs before failed delivery and retries idempotently before freezing', async () => {
    const f = await setup(); await f.advance(); f.setCostFails(true);
    const pending = await f.advance(); expect(pending.status).toBe('cost_delivery_pending'); expect(pending.progress.outcome).toBe('inconclusive');
    expect(f.counts().freezeCalls).toBe(0);
    f.setCostFails(false); expect((await f.advance()).status).toBe('ready'); expect([...f.delivered.values()]).toEqual([17]);
    expect(f.counts().generateCalls).toBe(1);
  });
  it('never retries an ambiguous effect; explicit bound reconciliation resumes it', async () => {
    const f = await setup(); let calls = 0; let request: AcquisitionRequest | undefined;
    f.p.acquisition.discover = async r => { request = r; calls++; throw new Error('ambiguous'); };
    expect((await f.advance()).status).toBe('reconciliation_required');
    expect((await f.advance()).status).toBe('reconciliation_required'); expect(calls).toBe(1);
    await f.p.operations.complete(request!.operationKey, reviewDigest(request), { status: 'rejected', rejection: { reasons: ['invalid_response'] } }, 'operator_receipt');
    expect((await f.advance()).task.phase).toBe('generation'); expect((await f.advance()).status).toBe('ready');
  });
  it('blocks a model, target or generator claiming human review authority', async () => {
    for (const principal of ['target-agent', 'fixture-generator']) {
      const f = await setup(); await f.advance();
      const real = f.p.readReview;
      f.p.readReview = async r => { const response = await real(r); if (response.status === 'decided') response.review.principalId = principal; return response; };
      const blocked = await f.advance(); expect(blocked.status).not.toBe('ready'); expect(f.counts().freezeCalls).toBe(0);
    }
  });
  it('does not admit incoming approvals without the authenticated review ledger', async () => {
    const f = await setup(); f.p.readReview = async () => ({ status: 'pending' });
    const initial = { sources: [fixtureSource()], cases: [fixtureCase()] };
    const first = await advanceDataOrchestration(fixtureSpec, initial, context, f.p);
    expect(first.status).not.toBe('ready'); expect(first.task.assessment.approvedAnswerCaseIds).toEqual([]);
  });
  it('rechecks current secret policy before completed replay or provider dispatch', async () => {
    const f = await setup(); await f.advance(); await f.advance(); f.p.knownSecrets = ['fixture-generator'];
    await expect(f.advance()).rejects.toThrow('Unsafe'); expect(f.counts().freezeCalls).toBe(1);
  });
  it('rejects a changed frozen reference and leaves it pending reconciliation', async () => {
    const f = await setup(); await f.advance();
    const real = f.p.freeze; f.p.freeze = async r => { const v = await real(r); if (v.status === 'complete') v.suite.referenceText = 'tampered'; return v; };
    expect((await f.advance()).status).toBe('reconciliation_required');
    expect((await f.advance()).status).toBe('reconciliation_required'); expect(f.counts().freezeCalls).toBe(1);
  });
  it('binds ledger identity, immutable results and current safety across restart', async () => {
    const f = await setup(); const ledger = f.p.operations; const digest = reviewDigest(empty);
    expect((await ledger.claim('fixture-op', digest)).claimed).toBe(true);
    expect((await f.reopen().operations.claim('fixture-op', digest)).record.state).toBe('pending');
    await expect(ledger.claim('fixture-op', reviewDigest(context))).rejects.toThrow('identity');
    await ledger.complete('fixture-op', digest, empty, 'receipt');
    await expect(ledger.complete('fixture-op', digest, { cases: ['changed'] })).rejects.toThrow('Immutable');
  });
  it('uses authenticated human intake, immutable receipts, exact snapshots and server-scoped reads', async () => {
    const f = await setup(); let authorized = false;
    const intake = createAuthenticatedDataReviewLedger({ operations: f.p.operations, authenticateHuman: async task => authorized && task.jobId === fixtureJob.jobId ? { principalId: 'fixture-human' } : null });
    const candidates = { sources: [fixtureSource()], cases: [fixtureCase()] };
    const digest = dataReviewRequestDigest(fixtureSpec, candidates);
    const response = await f.p.readReview({ digest, task: fixtureSpec, data: candidates });
    if (response.status !== 'decided') throw new Error('fixture');
    const input = { receiptId: 'immutable_receipt', task: fixtureSpec, candidates, reviewed: response.review.data, decision: 'approved' as const };
    await expect(intake.submit(input)).rejects.toThrow('authorization');
    authorized = true; await intake.submit(input); await intake.submit(input);
    const read = await intake.readReview({ digest, task: fixtureSpec, data: candidates });
    expect(read.status).toBe('decided');
    const changed = structuredClone(input); changed.reviewed.cases[0]!.input = 'Changed question';
    await expect(intake.submit(changed)).rejects.toThrow('snapshot');
    const changedTask = structuredClone(input); changedTask.task.description = 'Different scope';
    await expect(intake.submit(changedTask)).rejects.toThrow('identity');
    await expect(intake.readReview({ digest, task: changedTask.task, data: candidates })).rejects.toThrow('mismatch');
  });
  it('blocks approval when the human rejects or omits a candidate', async () => {
    const f = await setup(); await f.advance(); const real = f.p.readReview;
    f.p.readReview = async r => { const response = await real(r); if (response.status === 'decided') response.review.decision = 'rejected'; return response; };
    expect((await f.advance()).status).toBe('waiting_for_review');
    f.p.readReview = async r => { const response = await real(r); if (response.status === 'decided') response.review.data.cases = []; return response; };
    expect((await f.advance()).status).toBe('waiting_for_review'); expect(f.counts().freezeCalls).toBe(0);
  });
  it('holds expert drafts pending without claiming actual acquisition or dispatching them again', async () => {
    const f = await setup(); let expertCalls = 0;
    f.p.acquisition.generate = async request => {
      await createDataCostCapture(f.p.operations)({ operationKey: request.operationKey, taskKey: 'fixture-generation', cost: { jobId: fixtureJob.jobId, source: 'naive_session', role: 'evaluation_engineer', externalId: 'fixture-empty-session', purpose: 'fixture-generation', microUsd: 2, measured: true, recordedAt: '2026-11-07T00:00:00Z' } });
      return { status: 'complete', data: empty };
    };
    f.p.acquisition.expert = async request => { expertCalls++; expect(request.expertDraft?.status).toBe('draft_not_sent'); expect(request.expertDraft?.recipient).toBeNull(); return { status: 'pending' }; };
    await f.advance(); const fallback = await f.advance(); expect(fallback.task.state).toBe('waiting_for_expert');
    expect((await f.advance()).status).toBe('reconciliation_required');
    expect((await f.advance()).progress.outcome).toBe('inconclusive'); expect(expertCalls).toBe(1);
  });

});

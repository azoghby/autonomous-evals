// Corrected DQ-1/DQ-2 regressions against production data modules.
import { answerReviewContextDigest, reviewDigest } from './binding';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireEvaluationData, type EvaluationDataTask, type AcquisitionRequest, type DataBatch, type EvaluationDataPorts } from './acquisition';
import { createFileEvaluationDataStore } from './persistence';
import { assessDataQuality, inspectDataSafety } from './quality';
import { expertContributionContextDigest, reviewExpertContribution, type ExpertContribution, type ExpertContributionReview } from './expert';
import type { AnswerVerification, DataSource, DataTaskSpec, EvaluationDataCase } from './types';

const at = '2026-11-07T12:00:00Z';
const spec: DataTaskSpec = { taskId: 'review-task', jobId: 'review-job', targetId: 'target',
  description: 'Check permission reasoning', factualAnswersRequired: true,
  requirements: [{ id: 'permissions', description: 'Write capability', minimumCases: 1 }] };
const empty = (): DataBatch => ({ sources: [], cases: [] });
const item = (): EvaluationDataCase => ({ id: 'case', input: 'May a write-authorized user write?',
  requirementIds: ['permissions'], synthetic: true, generatorId: 'generator', sourceIds: [], expectedAnswer: 'No.' });
const approval = (): AnswerVerification => ({ status: 'approved', method: 'expert', verifierId: 'reviewer',
  independentOfTarget: true, independentOfGenerator: true, evidenceSourceIds: [], reviewedAnswer: 'No.',
  reviewedAt: at, rationale: 'Read-only users cannot write.',
  expertAttestation: { qualified: true, consentToEvaluation: true, contributionContextDigest: reviewDigest({ spec, consent: { evaluation: true }, qualification: 'authored expert fixture' }), contributionId: 'contribution' } });
const source = (): DataSource => {
  const content = 'Locally authored fixture: read-only users cannot write.';
  return { id: 'reference', content, url: 'https://example.org/fixture',
    license: { name: 'Local fixture', url: 'https://example.org/permission', permission: 'allowed', allowedUses: ['evaluation'] },
    provenance: { origin: 'public', producerId: 'publisher', retrievedAt: at,
      contentHash: createHash('sha256').update(content).digest('hex') },
    review: { status: 'approved', reviewerId: 'source-reviewer', reviewedAt: at, notes: 'Authored fixture only' } };
};
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'ae-data-quality-review-'));
  directories.push(path); return path;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function ports(): Promise<EvaluationDataPorts> {
  return { store: createFileEvaluationDataStore(await directory()), now: () => new Date(at),
    discover: async () => ({ status: 'complete', data: empty() }),
    generate: async () => ({ status: 'complete', data: empty() }), expert: async () => ({ status: 'pending' }) };
}

describe('Track B independent data quality review', () => {
  it('DQ-1: rejects approval for a different question', async () => {
    const p = await ports();
    p.discover = async () => ({ status: 'complete', data: { sources: [], cases: [item()] } });
    p.reviewCandidates = async data => ({ ...data, cases: data.cases.map(c => {
      const changed = { ...c, input: 'May a read-only user write?', verification: approval() };
      changed.verification.contextDigest = answerReviewContextDigest(spec, changed, data.sources);
      return changed; }) });
    const task = await acquireEvaluationData(spec, empty(), p);
    expect(task.cases).toEqual([]);
    expect(task.state).toBe('waiting_for_data');
    expect(task.assessment.approvedAnswerCaseIds).toEqual([]);
  });

  it('DQ-1: rejects expert review replay after the contribution question changes', () => {
    const contribution: ExpertContribution = { id: 'contribution', taskId: spec.taskId, contributorId: 'author',
      consent: { evaluation: true, allowedUses: ['evaluation'], receiptUrl: 'https://example.org/receipt' },
      qualificationEvidence: ['Private fixture qualification receipt'], sources: [],
      cases: [{ ...item(), input: 'May a read-only user write?' }] };
    const review: ExpertContributionReview = { contextDigest: expertContributionContextDigest(spec, contribution), contributionId: contribution.id, reviewerId: 'reviewer', reviewedAt: at,
      qualificationsVerified: true, consentVerified: true, conflictOfInterestCleared: true,
      approvedAnswers: [{ caseId: 'case', exactAnswer: 'No.', rationale: 'Read-only users cannot write.', evidenceSourceIds: [] }] };
    const approved = reviewExpertContribution(spec, contribution, review);
    expect(approved.accepted).toBe(true);
    expect(assessDataQuality(spec, approved.cases, []).status).toBe("sufficient");
    contribution.cases[0]!.input = item().input;
    const replay = reviewExpertContribution(spec, contribution, review);
    expect(replay.accepted).toBe(false);
    expect(replay.reasons).toContain('review_context_mismatch');
  });

  it('DQ-2: resume blocks newly known secrets before provider dispatch', async () => {
    const root = await directory();
    const p = await ports();
    p.store = createFileEvaluationDataStore(root);
    const value = 'opaque-confidential-fixture';
    p.discover = async () => ({ status: 'complete', data: { sources: [], cases: [{ ...item(), input: value }] } });
    const first = await acquireEvaluationData(spec, empty(), p);
    expect(first.phase).toBe('generation');
    expect(inspectDataSafety(first, [value]).safe).toBe(false);
    // Reopen the real file adapter, as after process restart. The API independently accepts knownSecrets.
    p.store = createFileEvaluationDataStore(root);
    p.knownSecrets = [value];
    let forwarded: AcquisitionRequest | undefined;
    p.generate = async request => { forwarded = structuredClone(request); return { status: 'pending' }; };
    await expect(acquireEvaluationData(spec, empty(), p)).rejects.toThrow('Unsafe persisted');
    expect(forwarded).toBeUndefined();
  });

  it('DQ-2: ready replay rejects data under the current secret policy', async () => {
    const p = await ports();
    const value = 'opaque-confidential-fixture';
    p.discover = async () => ({ status: 'complete', data: { sources: [], cases: [{ ...item(), input: value }] } });
    p.reviewCandidates = async data => ({ ...data, cases: data.cases.map(c => { const approved = { ...c, verification: approval() }; approved.verification.contextDigest = answerReviewContextDigest(spec, approved, data.sources); return approved; }) });
    expect((await acquireEvaluationData(spec, empty(), p)).state).toBe('ready');
    p.knownSecrets = [value];
    await expect(acquireEvaluationData(spec, empty(), p)).rejects.toThrow('Unsafe persisted');
  });

  it('control: configuring the current secret policy on the reopened file store blocks provider dispatch', async () => {
    const root = await directory();
    const p = await ports();
    p.store = createFileEvaluationDataStore(root);
    const value = 'opaque-confidential-fixture';
    p.discover = async () => ({ status: 'complete', data: { sources: [], cases: [{ ...item(), input: value }] } });
    await acquireEvaluationData(spec, empty(), p);
    p.knownSecrets = [value];
    p.store = createFileEvaluationDataStore(root, [value]);
    let calls = 0;
    p.generate = async () => { calls++; return { status: 'pending' }; };
    await expect(acquireEvaluationData(spec, empty(), p)).rejects.toThrow('storage read failed');
    expect(calls).toBe(0);
  });

  it.each(['discover', 'generate', 'expert'] as const)('control: %s cannot self-approve a synthetic factual answer', async phase => {
    const p = await ports();
    if (phase !== 'discover') await acquireEvaluationData(spec, empty(), p);
    if (phase === 'expert') await acquireEvaluationData(spec, empty(), p);
    p[phase] = async () => ({ status: 'complete', data: { sources: [], cases: [{ ...item(), verification: approval() }] } });
    const result = await acquireEvaluationData(spec, empty(), p);
    expect(result.state).not.toBe('ready');
    expect(result.cases[0]?.verification).toBeUndefined();
    expect(result.assessment.approvedAnswerCaseIds).toEqual([]);
  });

  it.each(['license', 'hash', 'synthetic', 'target', 'generator'] as const)('control: rejects %s provenance defects with independent-evidence verification', defect => {
    const s = source();
    const c = { ...item(), sourceIds: [s.id], verification: { ...approval(), method: 'independent_evidence' as const, evidenceSourceIds: [s.id] } };
    if (defect === 'license') s.license.allowedUses = [];
    if (defect === 'hash') s.content += ' altered';
    if (defect === 'synthetic') s.provenance.origin = 'synthetic';
    if (defect === 'target') s.provenance.producerId = spec.targetId;
    if (defect === 'generator') s.provenance.producerId = c.generatorId!;
    c.verification.contextDigest = answerReviewContextDigest(spec, c, [s]);
    const result = assessDataQuality(spec, [c], [s]);
    expect(result.acceptedCaseIds).toEqual([]);
    expect(result.factualCorrectness).toBe('unassessed');
  });

  it.each(['reviewer', 'author', 'generator', 'target'] as const)('control: expert gate rejects missing qualification or self-review (%s)', reviewerId => {
    const contribution: ExpertContribution = { id: 'contribution', taskId: spec.taskId, contributorId: 'author',
      consent: { evaluation: true, allowedUses: ['evaluation'], receiptUrl: 'https://example.org/receipt' },
      qualificationEvidence: ['Fixture qualification'], sources: [], cases: [item()] };
    const result = reviewExpertContribution(spec, contribution, { contributionId: contribution.id, reviewerId,
      reviewedAt: at, qualificationsVerified: reviewerId !== 'reviewer', consentVerified: true, conflictOfInterestCleared: true,
      approvedAnswers: [{ caseId: 'case', exactAnswer: 'No.', rationale: 'Fixture review', evidenceSourceIds: [] }] });
    expect(result.accepted).toBe(false);
    expect(result.cases).toEqual([]);
  });
  it.each(['legacy', 'input', 'requirements', 'lineage', 'answer', 'task', 'evidence', 'consent'] as const)(
    'DQ-1: approval fails closed after %s context changes', change => {
      const task = structuredClone(spec);
      const evidence = source();
      const c = { ...item(), sourceIds: [evidence.id], verification: approval() };
      c.verification.contextDigest = answerReviewContextDigest(task, c, [evidence]);
      expect(assessDataQuality(task, [c], [evidence]).status).toBe('sufficient');
      if (change === 'legacy') {
        delete c.verification.expertAttestation!.contributionContextDigest;
        c.verification.contextDigest = answerReviewContextDigest(task, c, [evidence]);
        expect(assessDataQuality(task, [c], [evidence]).approvedAnswerCaseIds).toEqual([]);
        delete c.verification.contextDigest;
      }
      if (change === 'input') c.input += ' changed';
      if (change === 'requirements') c.requirementIds = ['permissions', 'permissions'];
      if (change === 'lineage') c.generatorId = 'another-generator';
      if (change === 'answer') c.expectedAnswer = 'Yes.';
      if (change === 'task') task.description += ' changed';
      if (change === 'evidence') { evidence.content += ' changed'; evidence.provenance.contentHash = createHash('sha256').update(evidence.content).digest('hex'); }
      if (change === 'consent') c.verification.expertAttestation!.contributionContextDigest = reviewDigest('other-consent');
      expect(assessDataQuality(task, [c], [evidence]).approvedAnswerCaseIds).toEqual([]);
    });

  it.each(['legacy', 'task', 'consent', 'qualifications', 'case', 'evidence'] as const)(
    'DQ-1: expert ledger rejects changed %s snapshot', change => {
      const task = structuredClone(spec);
      const c: ExpertContribution = { id: 'contribution', taskId: task.taskId, contributorId: 'author',
        consent: { evaluation: true, allowedUses: ['evaluation'], receiptUrl: 'https://example.org/receipt' },
        qualificationEvidence: ['Fixture qualification'], sources: [source()], cases: [item()] };
      const review: ExpertContributionReview = { contextDigest: expertContributionContextDigest(task, c),
        contributionId: c.id, reviewerId: 'reviewer', reviewedAt: at, qualificationsVerified: true,
        consentVerified: true, conflictOfInterestCleared: true,
        approvedAnswers: [{ caseId: 'case', exactAnswer: 'No.', rationale: 'Fixture review', evidenceSourceIds: [] }] };
      expect(reviewExpertContribution(task, c, review).accepted).toBe(true);
      if (change === 'legacy') delete review.contextDigest;
      if (change === 'task') task.requirements[0]!.description += ' changed';
      if (change === 'consent') c.consent.receiptUrl += '/other';
      if (change === 'qualifications') c.qualificationEvidence.push('Different qualifications');
      if (change === 'case') c.cases[0]!.generatorId = 'other-generator';
      if (change === 'evidence') c.sources[0]!.license.name += ' changed';
      expect(reviewExpertContribution(task, c, review)).toMatchObject({ accepted: false, reasons: ['review_context_mismatch'] });
    });

  it('DQ-1: rejects in-place reviewer mutation without modifying persisted candidates', async () => {
    const p = await ports();
    p.discover = async () => ({ status: 'complete', data: { sources: [], cases: [item()] } });
    p.reviewCandidates = async data => { data.cases[0]!.input = 'Changed in place'; data.cases[0]!.verification = approval(); return data; };
    const result = await acquireEvaluationData(spec, empty(), p);
    expect(result.state).toBe('waiting_for_data');
    expect(result.cases).toEqual([]);
  });

  it.each(['pending', 'unavailable', 'complete'] as const)('DQ-2: screens CAS winner on %s result', async outcome => {
    const p = await ports();
    const first = await acquireEvaluationData(spec, empty(), p);
    const value = 'newly-known-cas-fixture';
    const winner: EvaluationDataTask = { ...first, cases: [{ ...item(), input: value }] };
    p.knownSecrets = [value];
    let reads = 0;
    p.store = { get: async () => ++reads === 1 ? first : winner,
      insertIfAbsent: async record => ({ inserted: false, record }), compareAndSet: async () => null };
    p.generate = async () => { if (outcome === 'unavailable') throw new Error('unavailable');
      return outcome === 'pending' ? { status: 'pending' } : { status: 'complete', data: empty() }; };
    await expect(acquireEvaluationData(spec, empty(), p)).rejects.toThrow('Unsafe persisted');
  });

});

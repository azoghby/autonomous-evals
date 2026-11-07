// Staged beside the unmodified production data modules by run.mjs.
// OPEN DEFECT tests characterize current failures. Green does NOT mean safe to integrate.
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireEvaluationData, type AcquisitionRequest, type DataBatch, type EvaluationDataPorts } from './acquisition';
import { createFileEvaluationDataStore } from './persistence';
import { assessDataQuality, inspectDataSafety } from './quality';
import { reviewExpertContribution, type ExpertContribution, type ExpertContributionReview } from './expert';
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
  expertAttestation: { qualified: true, consentToEvaluation: true, contributionId: 'contribution' } });
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
  it('OPEN DEFECT DQ-1: approval for a different question promotes the original incorrect answer', async () => {
    const p = await ports();
    p.discover = async () => ({ status: 'complete', data: { sources: [], cases: [item()] } });
    p.reviewCandidates = async data => ({ ...data, cases: data.cases.map(c => ({ ...c,
      input: 'May a read-only user write?', verification: approval() })) });
    const task = await acquireEvaluationData(spec, empty(), p);
    // Reviewer saw a question whose answer is No; the stored question's answer is Yes.
    expect(task.cases[0]?.input).toBe('May a write-authorized user write?');
    expect(task.cases[0]?.expectedAnswer).toBe('No.');
    expect(task.state).toBe('ready');
    expect(task.assessment.factualCorrectness).toBe('assessed');
    expect(task.assessment.approvedAnswerCaseIds).toEqual(['case']);
  });

  it('OPEN DEFECT DQ-1: expert review records can be replayed after the contribution question changes', () => {
    const contribution: ExpertContribution = { id: 'contribution', taskId: spec.taskId, contributorId: 'author',
      consent: { evaluation: true, allowedUses: ['evaluation'], receiptUrl: 'https://example.org/receipt' },
      qualificationEvidence: ['Private fixture qualification receipt'], sources: [],
      cases: [{ ...item(), input: 'May a read-only user write?' }] };
    const review: ExpertContributionReview = { contributionId: contribution.id, reviewerId: 'reviewer', reviewedAt: at,
      qualificationsVerified: true, consentVerified: true, conflictOfInterestCleared: true,
      approvedAnswers: [{ caseId: 'case', exactAnswer: 'No.', rationale: 'Read-only users cannot write.', evidenceSourceIds: [] }] };
    expect(reviewExpertContribution(spec, contribution, review).accepted).toBe(true);
    contribution.cases[0]!.input = item().input;
    const replay = reviewExpertContribution(spec, contribution, review);
    expect(replay.accepted).toBe(true);
    expect(assessDataQuality(spec, replay.cases, []).factualCorrectness).toBe('assessed');
  });

  it('OPEN DEFECT DQ-2: resume forwards persisted data containing a newly known secret to a provider', async () => {
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
    const resumed = await acquireEvaluationData(spec, empty(), p);
    expect(resumed.state).toBe('waiting_for_data');
    expect(forwarded?.untrustedData.cases[0]?.input).toBe(value);
  });

  it('OPEN DEFECT DQ-2: ready replay returns persisted data without applying the current secret policy', async () => {
    const p = await ports();
    const value = 'opaque-confidential-fixture';
    p.discover = async () => ({ status: 'complete', data: { sources: [], cases: [{ ...item(), input: value }] } });
    p.reviewCandidates = async data => ({ ...data, cases: data.cases.map(c => ({ ...c, verification: approval() })) });
    expect((await acquireEvaluationData(spec, empty(), p)).state).toBe('ready');
    p.knownSecrets = [value];
    const replay = await acquireEvaluationData(spec, empty(), p);
    expect(replay.state).toBe('ready');
    expect(inspectDataSafety(replay, p.knownSecrets).safe).toBe(false);
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
});

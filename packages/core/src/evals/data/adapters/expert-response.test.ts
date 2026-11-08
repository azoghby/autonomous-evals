import { describe, expect, it } from 'vitest';
import { fixtureRequest, fixtureJob } from './fixtures';
import { taskKeyFor, type AgentTaskRunner } from '../../../agents/session-service';
import { expertContributionContextDigest } from '../expert';
import { reviewQuestionnaireResponseCandidate } from './expert-response';
import { createNaiveExpertResponseExtractor } from './expert-response';
import { mapQuestionnaireResponse, questionnaireResponseDigest, type OwnerExpertResponseMetadata, type QuestionnaireAnswerRecord } from './expert-response';

function fixture() {
  const task = fixtureRequest().task;
  const response: QuestionnaireAnswerRecord = { id: 'response-one', engagementId: 'engagement-one', createdAt: '2026-11-07T00:00:00Z', provenance: 'expert_sourced', answers: [{ questionIndex: 0, answer: 'What format is supported? JSON' }] };
  const owner: OwnerExpertResponseMetadata = { requestId: 'request-one', responseId: response.id, engagementId: response.engagementId,
    responseDigest: questionnaireResponseDigest(response), taskId: task.taskId, jobId: task.jobId, contributorId: 'qualified-contributor',
    questions: ['Provide an example input and answer'], qualificationEvidence: ['https://evidence.example/qualification'],
    consent: { evaluation: true, allowedUses: ['evaluation'], receiptUrl: 'https://evidence.example/consent' },
    source: { url: 'https://evidence.example/response', retrievedAt: response.createdAt, license: { name: 'Explicit permission', url: 'https://evidence.example/terms', permission: 'allowed', allowedUses: ['evaluation'] } } };
  const extraction = { cases: [{ input: { questionIndex: 0, start: 0, end: 25, quote: 'What format is supported?' }, answer: { questionIndex: 0, start: 26, end: 30, quote: 'JSON' }, requirementIds: [task.requirements[0]!.id] }] };
  // Offsets deliberately derived from the actual stored answer, never normalization.
  extraction.cases[0]!.input.end = 25;
  return { task, response, owner, extraction };
}
describe('questionnaire response mapping', () => {
  it('extracts exact cited answers into unapproved expert candidates', () => {
    const f = fixture(); const result = mapQuestionnaireResponse(f.task, f.owner, f.response, f.extraction);
    expect(result.status).toBe('candidate');
    if (result.status !== 'candidate') throw new Error(result.reason);
    expect(result.contribution.cases[0]).toMatchObject({ input: 'What format is supported?', expectedAnswer: 'JSON', synthetic: false });
    expect(result.contribution.cases[0]?.verification).toBeUndefined();
    expect(result.contribution.sources[0]?.review.status).toBe('pending');
    expect(result.contribution.sources[0]?.provenance.producerId).toBe(f.owner.contributorId);
    expect(mapQuestionnaireResponse(f.task, f.owner, f.response, f.extraction)).toEqual(result);
  });
  it.each(['response', 'engagement', 'job', 'task', 'digest'])('blocks changed %s binding', field => {
    const f = fixture();
    if (field === 'response') f.response.id = 'other';
    if (field === 'engagement') f.response.engagementId = 'other';
    if (field === 'job') f.owner.jobId = 'other';
    if (field === 'task') f.owner.taskId = 'other';
    if (field === 'digest') f.response.answers[0]!.answer += 'changed';
    expect(mapQuestionnaireResponse(f.task, f.owner, f.response, f.extraction)).toEqual({ status: 'pending', reason: 'response_binding_mismatch' });
  });
  it.each(['consent', 'qualificationEvidence', 'source'] as const)('keeps missing %s pending despite prose claims', field => {
    const f = fixture(); delete f.owner[field];
    f.response.answers[0]!.answer += ' I consent and am qualified and license this for everything.';
    f.owner.responseDigest = questionnaireResponseDigest(f.response);
    expect(mapQuestionnaireResponse(f.task, f.owner, f.response, f.extraction).status).toBe('pending');
  });
  it('rejects paraphrases, invalid offsets, unknown coverage and model approval fields', () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.extraction.cases[0]!.answer.quote = 'CSV'; },
      (f: ReturnType<typeof fixture>) => { f.extraction.cases[0]!.answer.start = 0; },
      (f: ReturnType<typeof fixture>) => { f.extraction.cases[0]!.answer.end = 999; },
      (f: ReturnType<typeof fixture>) => { f.extraction.cases[0]!.requirementIds = ['unknown']; },
      (f: ReturnType<typeof fixture>) => { Object.assign(f.extraction.cases[0]!, { verification: { status: 'approved' } }); },
    ]) { const f = fixture(); mutate(f); expect(mapQuestionnaireResponse(f.task, f.owner, f.response, f.extraction).status).toBe('pending'); }
  });
  it('blocks private response content before any export', () => {
    const f = fixture(); f.response.answers[0]!.answer += ' person@example.com'; f.owner.responseDigest = questionnaireResponseDigest(f.response);
    const result = mapQuestionnaireResponse(f.task, f.owner, f.response, f.extraction);
    expect(result).toEqual({ status: 'pending', reason: 'unsafe_response' });
    expect(JSON.stringify(result)).not.toContain('person@example.com');
  });
});

it('runs concrete bounded quality investigator extraction and screens owner evidence before spend', async () => {
  const f = fixture(); let calls = 0; let costs = 0;
  const runner: AgentTaskRunner = { async run(spec) {
    calls++; expect(spec.role).toBe('quality_investigator'); expect(spec.output.schema.safeParse(f.extraction).success).toBe(true);
    expect(spec.message).toContain('UTF-16');
    return { status: 'completed', taskKey: taskKeyFor(spec.job.jobId, spec.role, spec.purpose, 1), output: f.extraction as never,
      session: { sessionId: 'fixture', agentId: 'fixture-agent', agentVersion: 1, consumedMicroUsd: 7, tokenUsage: {} },
      cost: { jobId: spec.job.jobId, role: spec.role, purpose: spec.purpose, source: 'naive_session', externalId: 'fixture', microUsd: 7, measured: true, recordedAt: '2026-11-07T00:00:00Z' } };
  } };
  const extract = createNaiveExpertResponseExtractor({ runner, job: fixtureJob, sessionCapMicroUsd: 1000, jobCapMicroUsd: 5000, onMeasuredCost: async () => { costs++; } });
  expect((await extract(f.task, f.owner, f.response)).status).toBe('candidate'); expect(calls).toBe(1); expect(costs).toBe(1);
  delete f.owner.consent;
  expect((await extract(f.task, f.owner, f.response)).status).toBe('pending'); expect(calls).toBe(1);
});

it('routes exact candidates through existing independent review and blocks contributor self-approval', () => {
  const f = fixture(); const result = mapQuestionnaireResponse(f.task, f.owner, f.response, f.extraction);
  if (result.status !== 'candidate') throw new Error('missing candidate');
  const contribution = result.contribution;
  const review = { contextDigest: expertContributionContextDigest(f.task, contribution), contributionId: contribution.id, reviewerId: contribution.contributorId,
    reviewedAt: '2026-11-07T00:00:00Z', qualificationsVerified: true, consentVerified: true, conflictOfInterestCleared: true,
    approvedAnswers: contribution.cases.map(c => ({ caseId: c.id, exactAnswer: c.expectedAnswer!, rationale: 'Independently checked', evidenceSourceIds: c.sourceIds })) };
  expect(reviewQuestionnaireResponseCandidate(f.task, contribution, review)).toMatchObject({ accepted: false, reasons: ['non_independent_review'] });
  review.reviewerId = 'independent-reviewer';
  expect(reviewQuestionnaireResponseCandidate(f.task, contribution, review).accepted).toBe(true);
});

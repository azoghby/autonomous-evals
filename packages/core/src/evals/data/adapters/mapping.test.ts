import { answerReviewContextDigest } from '../binding';
import { describe, expect, it } from 'vitest';
import { assessDataQuality } from '../quality';
import { freezeSuite } from '../../text/freeze';
import type { FrozenTextSuite, TextScenario } from '../../text/schema';
import { frozenDataReference, mapApprovedDataToTextDesign, projectDataBlockers } from './mapping';
import { fixtureJob, fixtureTask } from './fixtures';

const context = () => ({ job: structuredClone(fixtureJob), versionLabel: 'fixture-v1', systemPrompt: null });
function suite(referenceText: string | null): FrozenTextSuite {
  const scenarios: TextScenario[] = Array.from({ length: 12 }, (_, i) => { const id = `S${String(i + 1).padStart(2, '0')}`; return { id, title: 'Fixture scenario', category: i < 4 ? 'ordinary' : i < 8 ? 'instruction_edge' : 'grounding_ambiguity', userMessage: 'Which format is supported?', rationale: 'Locally authored suite fixture', severity: 'medium', objectiveChecks: [{ id: `${id}.o1`, kind: 'objective', description: 'Produces an answer', spec: { type: 'min_chars', value: 1 } }], rubricChecks: [] }; });
  return freezeSuite({ schemaVersion: 'text_suite.v1', jobId: fixtureJob.jobId, versionLabel: 'fixture-v1', frozenAt: '2026-11-07T00:00:00Z', systemPrompt: null, referenceText, scenarios, review: { sessions: [], rejections: [], reductions: [] } });
}
describe('approved evaluation data export', () => {
  it('uses accepted case IDs and independently verified exact answers while preserving provenance', () => {
    const task = fixtureTask(); const mapping = mapApprovedDataToTextDesign(task, context());
    if (mapping.status !== 'ready') throw new Error(mapping.reason);
    expect(mapping.caseIds).toEqual(['export-case']); expect(mapping.sourceIds).toEqual(['reference-source']);
    expect(mapping.designInput.referenceText).toContain('JSON');
    expect(mapping.designInput.referenceText).not.toContain('Ignore previous instructions');
    expect(mapping.provenance.sources[0]?.content).toContain('hostile source data');
    expect(mapping.provenance.cases[0]?.verification?.verifierId).toBe('answer-reviewer');
    expect(mapping.provenance.digest).toMatch(/^[a-f0-9]{64}$/);
    task.sources[0]!.content = 'mutated later';
    expect(mapping.provenance.sources[0]?.content).toContain('hostile source data');
  });
  it('rejects persisted approval forgery and answer edits even if readiness claims sufficient', () => {
    const task = fixtureTask(); task.cases[0]!.expectedAnswer = 'forged-answer';
    task.assessment.status = 'sufficient'; task.assessment.acceptedCaseIds = ['export-case']; task.assessment.approvedAnswerCaseIds = ['export-case'];
    expect(mapApprovedDataToTextDesign(task, context()).status).toBe('blocked');
    const unaccepted = fixtureTask(); unaccepted.assessment.acceptedCaseIds = [];
    expect(mapApprovedDataToTextDesign(unaccepted, context()).status).toBe('blocked');
  });
  it('never treats synthetic source output or unverified generated answers as factual truth', () => {
    const task = fixtureTask(); task.cases[0]!.synthetic = true; task.cases[0]!.generatorId = 'generator'; delete task.cases[0]!.verification;
    expect(mapApprovedDataToTextDesign(task, context()).status).toBe('blocked');
    const syntheticSource = fixtureTask(); syntheticSource.sources[0]!.provenance.origin = 'synthetic';
    expect(mapApprovedDataToTextDesign(syntheticSource, context()).status).toBe('blocked');
    const independentlyReviewed = fixtureTask(); independentlyReviewed.cases[0]!.synthetic = true; independentlyReviewed.cases[0]!.generatorId = 'generator';
    independentlyReviewed.cases[0]!.verification!.contextDigest = answerReviewContextDigest(independentlyReviewed.spec, independentlyReviewed.cases[0]!, independentlyReviewed.sources);
    independentlyReviewed.assessment = assessDataQuality(independentlyReviewed.spec, independentlyReviewed.cases, independentlyReviewed.sources);
    const mapping = mapApprovedDataToTextDesign(independentlyReviewed, context());
    expect(mapping.status).toBe('ready'); if (mapping.status === 'ready') expect(mapping.provenance.cases[0]?.synthetic).toBe(true);
  });
  it('keeps behavioral only synthetic coverage factual reference null', () => {
    const task = fixtureTask(); task.spec.factualAnswersRequired = false; const candidate = task.cases[0]!;
    candidate.synthetic = true; candidate.generatorId = 'generator'; candidate.sourceIds = []; delete candidate.expectedAnswer; delete candidate.verification; task.sources = [];
    task.assessment = assessDataQuality(task.spec, task.cases, task.sources);
    const mapping = mapApprovedDataToTextDesign(task, context()); expect(mapping.status).toBe('ready');
    if (mapping.status === 'ready') { expect(mapping.designInput.referenceText).toBeNull(); expect(mapping.assessment.factualCorrectness).toBe('unassessed'); }
  });
  it('binds frozen suite reference and digest without editing the suite', () => {
    const task = fixtureTask(); const mapping = mapApprovedDataToTextDesign(task, context()); if (mapping.status !== 'ready') throw new Error(mapping.reason);
    const frozen = suite(mapping.designInput.referenceText); const before = structuredClone(frozen);
    expect(frozenDataReference(task, frozen, context())).toEqual({ suiteDigest: frozen.digest, provenance: mapping.provenance }); expect(frozen).toEqual(before);
    expect(() => frozenDataReference(task, suite('unrelated reference'), context())).toThrow();
    expect(() => frozenDataReference(task, { ...frozen, referenceText: 'tampered' }, context())).toThrow();
  });
  it('does not export incomplete readiness or a different job scope', () => {
    const task = fixtureTask(); task.state = 'waiting_for_expert'; expect(mapApprovedDataToTextDesign(task, context()).status).toBe('blocked');
    const wrongJob = context(); wrongJob.job.jobId = 'other-job'; expect(mapApprovedDataToTextDesign(fixtureTask(), wrongJob).status).toBe('blocked');
  });
  it('projects data and expert waiting only into fixed input blockers with opaque references', () => {
    for (const state of ['waiting_for_data', 'waiting_for_expert'] as const) {
      const task = fixtureTask(); task.state = state;
      expect(projectDataBlockers(task, { id: 'data-blocker', evidenceRef: 'data-evidence' })).toEqual([{ id: 'data-blocker', evidenceRef: 'data-evidence', kind: 'input' }]);
    }
    expect(projectDataBlockers(fixtureTask(), { id: 'data-blocker', evidenceRef: 'data-evidence' })).toEqual([]);
  });
});

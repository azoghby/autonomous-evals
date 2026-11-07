import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDurableProgressProjection } from '../../../packages/core/src/reporting/chat/projection/index.js';
import type { DurableProgressRead, ProgressProjectionPorts, ProjectionPlan } from '../../../packages/core/src/reporting/chat/projection/types.js';
import { createProgressChatService } from '../../../packages/core/src/reporting/chat/service.js';
import type { ChatExchange } from '../../../packages/core/src/reporting/chat/types.js';
import { makeSuite } from '../../../packages/core/src/evals/text/__tests__/fixtures.js';
import { assessDataQuality } from '../../../packages/core/src/evals/data/quality.js';
import type { EvaluationDataTask } from '../../../packages/core/src/evals/data/acquisition.js';
import type { CalendarInvestigation } from '../../../packages/core/src/evals/calendar-integration/index.js';

const time = '2026-11-07T20:00:00.000Z';
const scope = { subjectId: 'alice', jobId: 'job' };
function fixture() {
  const plan: ProjectionPlan = { scope, environment: 'test', checkpoints: [], acquisitionTaskIds: [] };
  const read: DurableProgressRead = { scope, observedAt: time, job: { jobId: 'job', status: 'delivered', updatedAt: time }, checkpoints: [], acquisition: [], costs: [], unknownCosts: true };
  let reads = 0;
  const ports: ProgressProjectionPorts = {
    referenceKey: 'local-synthetic-reference-key-at-least-32-bytes',
    access: { authenticate: async () => ({ subjectId: 'alice' }), resolveAuthorizedJob: async (_caller, jobId) => jobId === 'job' ? scope : null },
    resolve: async () => plan, reader: { read: async () => { reads++; return read; } },
  };
  function checkpoint(format: ProjectionPlan['checkpoints'][number]['format'], kind: string, value: unknown) {
    const key = { jobId: 'job', kind, id: 'operation', inputDigest: 'a'.repeat(64) };
    plan.checkpoints.push({ key, format, phase: format === 'text_design' ? 'planning' : 'investigating' });
    read.checkpoints.push({ key: { ...key }, record: { state: 'completed', value } });
  }
  return { plan, read, ports, checkpoint, reads: () => reads, project: () => createDurableProgressProjection(ports).project(scope) };
}
function design() {
  const f = fixture();
  const suite = makeSuite({ jobId: 'job' });
  f.checkpoint('text_design', 'design', { status: 'completed', suite, costs: [] });
  f.plan.checkpoints[0]!.suiteDigest = suite.digest;
  return { ...f, suite };
}
function acquisition() {
  const f = design();
  const content = 'Reviewed source evidence.';
  const task: EvaluationDataTask = {
    taskId: 'task', revision: 0, requestHash: 'c'.repeat(64), state: 'ready', phase: 'complete', updatedAt: time, decisions: [],
    spec: { taskId: 'task', jobId: 'job', targetId: 'target', description: 'Coverage', factualAnswersRequired: false, requirements: [{ id: 'r', description: 'Requirement', minimumCases: 1 }] },
    sources: [{ id: 'source', url: 'https://example.org/evidence', content,
      license: { name: 'CC0', url: 'https://example.org/license', permission: 'allowed', allowedUses: ['evaluation'] },
      provenance: { origin: 'public', producerId: 'publisher', retrievedAt: time, contentHash: createHash('sha256').update(content).digest('hex') },
      review: { status: 'approved', reviewerId: 'reviewer', reviewedAt: time, notes: '' } }],
    cases: [{ id: 'case', input: 'Case input', requirementIds: ['r'], sourceIds: ['source'], synthetic: false }],
    assessment: { status: 'unassessed', factualCorrectness: 'unassessed', acceptedCaseIds: [], approvedAnswerCaseIds: [], coverage: [], issues: [] },
  };
  task.assessment = assessDataQuality(task.spec, task.cases, task.sources);
  f.plan.acquisitionTaskIds = ['task']; f.read.acquisition = [{ taskId: 'task', record: task }];
  return { ...f, task };
}

describe('CHARACTERIZATION: passing tests below demonstrate defects, not acceptance criteria', () => {
  it('R1 accepts a valid same-job frozen suite different from the expected suite digest', async () => {
    const f = design(); f.plan.checkpoints[0]!.suiteDigest = 'd'.repeat(64);
    const p = await f.project();
    expect(p.snapshot.status).toBe('delivered'); expect(p.snapshot.blockers).toEqual([]);
  });
  it('R2 accepts a calendar investigation whose typed original belongs to another job/run/branch/suite', async () => {
    const f = fixture();
    const investigation: CalendarInvestigation = { original: { jobId: 'foreign-job', runId: 'foreign-run', branchId: 'foreign-branch', suiteHash: 'foreign-suite', versionLabel: 'v1', origin: 'customer', results: [] }, findings: [], reproductions: [], pendingScenarioIds: [] };
    f.checkpoint('calendar_investigation', 'calendar_investigation', investigation);
    Object.assign(f.plan.checkpoints[0]!, { runId: 'expected-run', branchId: 'expected-branch', suiteDigest: 'expected-suite', scenarioIds: ['scenario'] });
    const p = await f.project();
    expect(p.snapshot.status).toBe('delivered'); expect(p.snapshot.blockers).toEqual([]);
    expect(JSON.stringify(p)).not.toContain('foreign-job'); // No cross-tenant body disclosure claimed.
  });
  it.each(['review', 'retrieval'] as const)('R3 accepts ready data with %s after the watermark', async field => {
    const f = acquisition();
    if (field === 'review') f.task.sources[0]!.review.reviewedAt = '2027-01-01T00:00:00.000Z';
    else f.task.sources[0]!.provenance.retrievedAt = '2027-01-01T00:00:00.000Z';
    f.task.assessment = assessDataQuality(f.task.spec, f.task.cases, f.task.sources);
    expect(f.task.assessment.status).toBe('sufficient');
    const p = await f.project();
    expect(p.snapshot.observedAt).toBe(time); expect(p.acquisition[0]!.state).toBe('ready'); expect(p.snapshot.status).toBe('delivered');
  });
  it('R4 replay/history bypass newly supplied secret policy while a fresh poll refuses', async () => {
    const f = design(); let secrets: readonly string[] = []; let stored: ChatExchange | null = null;
    f.ports.knownSecrets = () => secrets;
    const service = createProgressChatService({ access: f.ports.access, progress: createDurableProgressProjection(f.ports), conversations: {
      get: async () => stored, list: async () => stored ? [stored] : [], append: async (_scope, input) => (stored = { ...input, sequence: 1 }),
    } });
    const first = await service.send({ jobId: 'job', messageId: 'm1', question: 'status' });
    secrets = ['delivered']; // Synthetic policy marker, not a real credential or exploit.
    await expect(service.poll({ jobId: 'job' })).rejects.toMatchObject({ code: 'invalid_snapshot' });
    expect((await service.send({ jobId: 'job', messageId: 'm1', question: 'status' })).reply.text).toContain('delivered');
    expect((await service.history({ jobId: 'job' })).messages[0]!.reply).toEqual(first.reply);
  });
});

describe('ACCEPTANCE: meaningful controls which must remain true after fixes', () => {
  it('accepts matching suite and current reviewed acquisition', async () => {
    const f = acquisition(); expect(f.task.assessment.status).toBe('sufficient');
    expect((await f.project()).snapshot.status).toBe('delivered');
  });
  it('rejects wrong-job frozen suite', async () => {
    const f = fixture(); f.checkpoint('text_design', 'design', { status: 'completed', suite: makeSuite({ jobId: 'other' }) });
    await expect(f.project()).rejects.toMatchObject({ code: 'invalid_snapshot' });
  });
  it('rejects reader checkpoint digest drift', async () => {
    const f = design(); f.read.checkpoints[0]!.key.inputDigest = 'e'.repeat(64);
    await expect(f.project()).rejects.toMatchObject({ code: 'invalid_snapshot' });
  });
  it('rejects stale approval after source content changes', async () => {
    const f = acquisition(); f.task.sources[0]!.content = 'Changed evidence';
    await expect(f.project()).rejects.toMatchObject({ code: 'invalid_snapshot' });
  });
  it('rechecks ready acquisition under current secret screening', async () => {
    const f = acquisition(); f.ports.knownSecrets = () => ['Case input'];
    await expect(f.project()).rejects.toMatchObject({ code: 'invalid_snapshot' });
  });
  it('rejects task update after the watermark', async () => {
    const f = acquisition(); f.task.updatedAt = '2027-01-01T00:00:00.000Z';
    await expect(f.project()).rejects.toMatchObject({ code: 'invalid_snapshot' });
  });
  it('denies wrong subject before durable reads', async () => {
    const f = design(); f.ports.access.authenticate = async () => ({ subjectId: 'bob' });
    await expect(f.project()).rejects.toMatchObject({ code: 'not_found' }); expect(f.reads()).toBe(0);
  });
  it('rejects foreign and duplicate measured costs', async () => {
    const f = design(); const cost = { jobId: 'other', source: 'naive_session' as const, role: null, externalId: 'session', purpose: 'eval', measured: true, microUsd: 10, recordedAt: time };
    f.read.costs = [cost]; await expect(f.project()).rejects.toMatchObject({ code: 'invalid_snapshot' });
    cost.jobId = 'job'; f.read.costs = [cost, { ...cost }]; await expect(f.project()).rejects.toMatchObject({ code: 'invalid_snapshot' });
  });
});

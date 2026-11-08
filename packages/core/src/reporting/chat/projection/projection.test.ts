import { describe, expect, it } from 'vitest';
import { createProgressChatService } from '../service.js';
import { createDurableProgressProjection } from './index.js';
import type { DurableProgressRead, ProgressProjectionPorts, ProjectionPlan, ProjectedOutcome } from './types.js';
import { SuiteRunSchema } from '../../../evals/text/schema.js';
import { FindingSchema } from '../../../evals/types.js';

const time = '2026-11-07T10:00:00.000Z';
const scope = { subjectId: 'viewer', jobId: 'job' };
function setup() {
  const plan: ProjectionPlan = { scope, environment: 'test', checkpoints: [], acquisitionTaskIds: [] };
  const read: DurableProgressRead = { scope, observedAt: time, job: { jobId: 'job', status: 'running', updatedAt: time }, checkpoints: [], acquisition: [], costs: [], unknownCosts: true };
  let reads = 0; let auth = 0;
  const ports: ProgressProjectionPorts = { access: { authenticate: async () => { auth++; return { subjectId: 'viewer' }; }, resolveAuthorizedJob: async () => scope },
    referenceKey: 'a-private-reference-key-at-least-32-bytes', resolve: async () => plan, reader: { read: async () => { reads++; return read; } } };
  return { plan, read, ports, counts: () => ({ reads, auth }), adapter: () => createDurableProgressProjection(ports) };
}
function textRun(s: ReturnType<typeof setup>, status: string, outcome = 'completed') {
  const key = { jobId: 'job', kind: 'run_result', id: 'run', inputDigest: 'a'.repeat(64) };
  s.plan.checkpoints.push({ key, phase: 'running', format: 'text_run', runId: 'run', suiteDigest: 'b'.repeat(64), scenarioIds: ['S01'] });
  s.read.checkpoints.push({ key, record: { state: 'completed', value: { environment: 'test', run: {
    schemaVersion: 'text_run.v1', jobId: 'job', suiteDigest: 'b'.repeat(64), versionLabel: 'v1', runId: 'run', startedAt: time, completedAt: time,
    executions: [{ scenarioId: 'S01', runId: 'run', attempt: 'initial', outcome, target: { ok: outcome === 'completed', errorCode: null, latencyMs: 1 },
      responseText: 'PRIVATE CUSTOMER TEXT', responseClipped: false, startedAt: time, completedAt: time,
      checks: [{ checkId: 'S01.o1', kind: 'objective', status, detail: 'PRIVATE DETAIL', evidenceQuotes: [], reason: null }] }],
  } } } });
}
function textFinding() {
  const s = setup(); textRun(s, 'fail');
  const value = (s.read.checkpoints[0].record as { state: 'completed'; value: { run: unknown } }).value;
  const run = SuiteRunSchema.parse(value.run);
  const reproduction = { ...structuredClone(run.executions[0]), runId: 'repro-run', attempt: 'reproduction' as const };
  const finding = FindingSchema.parse({ id: 'text:S01:S01.o1', source: 'text_eval', category: 'explicit_constraint', title: 'PRIVATE TITLE',
    label: 'confirmed', severity: 'high', basis: 'objective', summary: 'PRIVATE SUMMARY', investigatorNote: null,
    evidence: [{ kind: 'check', checkId: 'S01.o1', detail: 'PRIVATE DETAIL' }],
    reproduction: { attempted: true, reproduced: true, runId: 'repro-run' } });
  const investigation = { investigatorStatus: 'completed', findings: [finding], reproductions: [reproduction], testDefects: [] };
  const key = { jobId: 'job', kind: 'investigation', id: 'run', inputDigest: 'c'.repeat(64) };
  s.plan.checkpoints.push({ ...s.plan.checkpoints[0], key, phase: 'investigating', format: 'text_investigation' });
  s.read.checkpoints.push({ key, record: { state: 'completed', value: investigation } });
  return { ...s, finding, investigation };
}
describe('durable progress projection', () => {
  it('projects confirmed text findings with stable private references and no prose', async () => {
    const s = textFinding(); const first = await s.adapter().project(scope);
    expect(first.snapshot.findings).toHaveLength(1);
    expect(first.snapshot.findings[0]).toMatchObject({ status: 'confirmed', severity: 'high' });
    expect(first.snapshot.findings[0].id).toMatch(/^ev_[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain('PRIVATE');
    expect(await s.adapter().project(scope)).toEqual(first);
  });
  it.each(['rubric_concern', 'inconclusive'] as const)('retains %s findings without requiring confirmed reproduction', async label => {
    const s = textFinding(); s.finding.label = label; s.finding.reproduction = null;
    s.investigation.reproductions = [];
    expect((await s.adapter().project(scope)).snapshot.findings[0].status).toBe(label);
  });
  it.each(['missing_baseline', 'wrong_run', 'wrong_suite', 'wrong_check', 'wrong_source', 'duplicate', 'missing_reproduction', 'wrong_reproduction', 'passing_reproduction', 'infrastructure_reproduction'])(
    'rejects text finding association: %s', async kind => {
      const s = textFinding();
      if (kind === 'missing_baseline') { s.plan.checkpoints.shift(); s.read.checkpoints.shift(); }
      if (kind === 'wrong_run') s.plan.checkpoints[1].runId = 'other';
      if (kind === 'wrong_suite') s.plan.checkpoints[1].suiteDigest = 'd'.repeat(64);
      if (kind === 'wrong_check') s.finding.evidence = [{ kind: 'check', checkId: 'other', detail: 'private' }];
      if (kind === 'wrong_source') s.finding.source = 'trace_audit';
      if (kind === 'duplicate') s.investigation.findings.push(structuredClone(s.finding));
      if (kind === 'missing_reproduction') s.investigation.reproductions = [];
      if (kind === 'wrong_reproduction') s.finding.reproduction!.runId = 'other';
      if (kind === 'passing_reproduction') s.investigation.reproductions[0].checks[0].status = 'pass';
      if (kind === 'infrastructure_reproduction') s.investigation.reproductions[0].outcome = 'infrastructure_error';
      await expect(s.adapter().project(scope)).rejects.toMatchObject({ code: 'invalid_snapshot' });
    });
  it.each<[string, ProjectedOutcome]>([['pass', 'passed'], ['fail', 'product_failure'], ['concern', 'rubric_concern'], ['inconclusive', 'inconclusive'], ['not_assessed', 'not_assessed'], ['error', 'error']])('preserves text check %s', async (input, expected) => {
    const s = setup(); textRun(s, input);
    const p = await s.adapter().project(scope);
    expect(p.phases[0].outcomes).toEqual([expected]);
    expect(p.snapshot.status).toBe('running');
    expect(JSON.stringify(p)).not.toContain('PRIVATE');
    expect(p.snapshot.blockers.length).toBe(['inconclusive', 'not_assessed', 'error'].includes(input) ? 1 : 0);
  });
  it('retains infrastructure outcome even if checks say pass', async () => {
    const s = setup(); textRun(s, 'pass', 'infrastructure_error');
    expect((await s.adapter().project(scope)).phases[0].outcomes).toEqual(['infrastructure_error']);
  });
  it.each(['passed', 'product_failure', 'inconclusive', 'infrastructure_error'] as const)('preserves calendar %s', async outcome => {
    const s = setup(); const key = { jobId: 'job', kind: 'calendar_run', id: 'op', inputDigest: 'a'.repeat(64) };
    s.plan.checkpoints = [{ key, phase: 'running', format: 'calendar_run', runId: 'run', branchId: 'branch', suiteDigest: 'suite', scenarioIds: ['scenario'] }];
    s.read.checkpoints = [{ key, record: { state: 'completed', value: { jobId: 'job', runId: 'run', branchId: 'branch', suiteHash: 'suite', versionLabel: 'v1', origin: 'customer', results: [{ scenarioId: 'scenario', scope: { jobId: 'job', version: 'v1', runId: 'scenario-run' }, outcome, reason: 'private error' }] } } }];
    const p = await s.adapter().project(scope); expect(p.phases[0].outcomes).toEqual([outcome]); expect(p.snapshot.status).toBe('running');
  });
  it.each(['pending', 'ambiguous', 'missing'] as const)('projects %s checkpoints without completion', async state => {
    const s = setup(); const key = { jobId: 'job', kind: 'investigation', id: 'op', inputDigest: 'a'.repeat(64) };
    s.plan.checkpoints = [{ key, phase: 'investigating', format: 'text_investigation' }];
    s.read.checkpoints = [{ key, record: state === 'missing' ? null : { state } }];
    const p = await s.adapter().project(scope); expect(p.phases[0].state).toBe(state); expect(p.snapshot.blockers).toHaveLength(1); expect(p.snapshot.milestones).toEqual([]);
  });
  it.each(['waiting_for_data', 'waiting_for_expert', 'acquiring'] as const)('retains %s and saved phase without exposing acquisition text', async state => {
    const s = setup(); s.plan.acquisitionTaskIds = ['task'];
    s.read.acquisition = [{ taskId: 'task', record: { taskId: 'task', revision: 3, requestHash: 'c'.repeat(64), spec: { taskId: 'task', jobId: 'job', description: 'PRIVATE', targetId: 'https://private', factualAnswersRequired: false, requirements: [] }, state, phase: 'expert', updatedAt: time, sources: [], cases: [], decisions: [{ id: 'private-id', phase: 'expert', outcome: 'PRIVATE', at: time }], assessment: { status: 'insufficient', factualCorrectness: 'unassessed', acceptedCaseIds: [], approvedAnswerCaseIds: [], coverage: [], issues: [] } } }];
    const p = await s.adapter().project(scope); expect(p.acquisition[0]).toMatchObject({ state, phase: 'expert' }); expect(p.snapshot.blockers[0].kind).toBe('input'); expect(JSON.stringify(p)).not.toContain('PRIVATE');
  });
  it('projects complete measured costs with stable opaque references, never estimates unknown costs', async () => {
    const s = setup(); s.read.costs = [{ jobId: 'job', source: 'naive_session', role: null, externalId: 'https://private-session', purpose: 'PRIVATE', microUsd: 123, measured: true, recordedAt: time }];
    const a = await s.adapter().project(scope); const b = await s.adapter().project(scope);
    expect(a).toEqual(b); expect(a.snapshot.costs[0]).toMatchObject({ source: 'naive', microUsd: 123 }); expect(a.snapshot.unknownCosts).toBe(true); expect(a.snapshot.costs[0].id).toMatch(/^ev_[a-f0-9]{64}$/);
  });
  it('wires directly into chat; authenticates on every poll and deterministic unchanged cursor', async () => {
    const s = setup(); textRun(s, 'not_assessed');
    const service = createProgressChatService({ access: s.ports.access, progress: s.adapter(), conversations: { get: async () => null, list: async () => [], append: async (_scope, input) => ({ ...input, sequence: 1 }) } });
    const first = await service.poll({ jobId: 'job' }); const second = await service.poll({ jobId: 'job', cursor: first.cursor });
    expect(second.changed).toBe(false); expect(first.reply?.text).toContain('Recorded job status: running'); expect(first.reply?.unknowns.join(' ')).toContain('percentage complete'); expect(s.counts()).toEqual({ auth: 4, reads: 2 });
  });
});

describe('investigation resolution and get-only reader composition', () => {
  it.each(['pending', 'credential_refused', 'invalid_output', 'invalid_identity'])('blocks saved text investigation %s', async investigatorStatus => {
    const s = setup(); const key = { jobId: 'job', kind: 'investigation', id: 'run', inputDigest: 'a'.repeat(64) };
    s.plan.checkpoints = [{ key, phase: 'investigating', format: 'text_investigation' }];
    s.read.checkpoints = [{ key, record: { state: 'completed', value: { investigatorStatus, findings: [], testDefects: [], reproductions: [] } } }];
    expect((await s.adapter().project(scope)).phases[0].state).toBe('blocked');
    s.read.job.status = 'delivered'; await expect(s.adapter().read(scope)).rejects.toMatchObject({ code: 'invalid_snapshot' });
  });
  it('blocks saved calendar investigation with pending reproductions', async () => {
    const s = setup(); const key = { jobId: 'job', kind: 'calendar_investigation', id: 'op', inputDigest: 'a'.repeat(64) };
    s.plan.checkpoints = [{ key, phase: 'investigating', format: 'calendar_investigation', runId: 'run', branchId: 'branch', suiteDigest: 'suite', scenarioIds: ['scenario'] }];
    const runScope = { jobId: 'job', version: 'v1', runId: 'scenario-run' };
    s.read.checkpoints = [{ key, record: { state: 'completed', value: {
      original: { jobId: 'job', runId: 'run', branchId: 'branch', suiteHash: 'suite', versionLabel: 'v1', results: [{ scenarioId: 'scenario', scope: runScope, outcome: 'product_failure' }] },
      findings: [{ id: 'finding', severity: 'medium', scenarioId: 'scenario', status: 'inconclusive', reproductions: 0, association: { jobId: 'job', branchId: 'branch', suiteHash: 'suite', scope: runScope } }],
      pendingScenarioIds: ['scenario'], reproductions: [],
    } } }];
    expect((await s.adapter().project(scope)).phases[0].state).toBe('blocked');
  });
  it('does not infer delivered from a passing run; requires explicit persisted job status', async () => {
    const s = setup(); textRun(s, 'pass'); expect((await s.adapter().read(scope)).status).toBe('running');
    s.read.job.status = 'delivered'; expect((await s.adapter().read(scope)).status).toBe('delivered');
  });
  it('rejects partial completed run and mismatched saved suite', async () => {
    const s = setup(); textRun(s, 'pass'); s.plan.checkpoints[0]!.scenarioIds = ['S01', 'S02'];
    await expect(s.adapter().read(scope)).rejects.toMatchObject({ code: 'invalid_snapshot' });
    s.plan.checkpoints[0]!.scenarioIds = ['S01']; s.plan.checkpoints[0]!.suiteDigest = 'd'.repeat(64);
    await expect(s.adapter().read(scope)).rejects.toMatchObject({ code: 'invalid_snapshot' });
  });
  it('assembles each expected get within the supplied consistent view without calling mutators', async () => {
    const { createDurableProgressReader } = await import('./reader.js');
    const s = setup(); textRun(s, 'pass'); s.plan.acquisitionTaskIds = ['task']; let boundaries = 0; const gets: unknown[] = [];
    const reader = createDurableProgressReader({ withRead: async (plan, work) => {
      boundaries++; expect(plan).toBe(s.plan);
      return work({ observedAt: time, job: s.read.job, costs: [], unknownCosts: true,
        checkpoints: { get: async key => { gets.push(key); return s.read.checkpoints[0]!.record; } },
        acquisition: { get: async id => { gets.push(id); return null; } } });
    } });
    const read = await reader.read(s.plan); expect(boundaries).toBe(1); expect(gets).toEqual([s.plan.checkpoints[0]!.key, 'task']);
    expect(read.acquisition).toEqual([{ taskId: 'task', record: null }]);
  });
});

describe('additional unresolved evidence gates', () => {
  it('projects blocked design without leaking reason or implying delivery', async () => {
    const s = setup(); const key = { jobId: 'job', kind: 'design', id: 'suite', inputDigest: 'a'.repeat(64) };
    s.plan.checkpoints = [{ key, phase: 'planning', format: 'text_design' }];
    s.read.checkpoints = [{ key, record: { state: 'completed', value: { status: 'blocked', reason: 'PRIVATE SECRET', costs: [] } } }];
    const p = await s.adapter().project(scope); expect(p.phases[0].state).toBe('blocked'); expect(p.snapshot.blockers).toHaveLength(1); expect(JSON.stringify(p)).not.toContain('PRIVATE');
  });
  it('rejects stale ready acquisition assessments and wrong-job task records', async () => {
    const s = setup(); s.plan.acquisitionTaskIds = ['task'];
    const record = { taskId: 'task', revision: 0, requestHash: 'c'.repeat(64), spec: { taskId: 'task', jobId: 'job', description: 'data', targetId: 'target', factualAnswersRequired: false, requirements: [] }, state: 'ready' as const, phase: 'complete' as const, updatedAt: time, sources: [], cases: [], decisions: [], assessment: { status: 'sufficient' as const, factualCorrectness: 'unassessed' as const, acceptedCaseIds: [], approvedAnswerCaseIds: [], coverage: [], issues: [] } };
    s.read.acquisition = [{ taskId: 'task', record }];
    await expect(s.adapter().read(scope)).rejects.toMatchObject({ code: 'invalid_snapshot' });
    record.spec.jobId = 'another-job'; await expect(s.adapter().read(scope)).rejects.toMatchObject({ code: 'invalid_snapshot' });
  });
  it('preserves absence of acquisition records as an input blocker', async () => {
    const s = setup(); s.plan.acquisitionTaskIds = ['task']; s.read.acquisition = [{ taskId: 'task', record: null }];
    const p = await s.adapter().project(scope); expect(p.acquisition[0]).toMatchObject({ state: 'missing', phase: null }); expect(p.snapshot.blockers[0]?.kind).toBe('input');
  });
});

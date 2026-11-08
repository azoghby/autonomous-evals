import { NaiveProxyJudgePendingError, NaiveProxyJudgeReconciliationRequiredError } from '../../judges/naive-proxy';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresAgentTaskStore, PostgresBudgetLedger, type AgentTransactionalSql } from '../../agents/postgres-ports';
import { AgentSessionService } from '../../agents/session-service';
import { harness } from '../../agents/__tests__/fakes';
import type { ServiceContext } from '../../contracts/services';
import type { TextTargetPort, JobRef, RubricJudge } from '../types';
import { createTrackBServices } from '../service-adapter';
import { makeScenarios } from '../text/__tests__/fixtures';
import { PostgresTextCheckpointStore, type TextCheckpointStore } from './checkpoints';
import { createTextEvaluationServices, toLegacyRunResult } from './services';

const job: JobRef = { jobId: 'integration-job', customerId: 'fixture-customer', package: 'text_eval', environment: 'test', quoteVersion: null, linkedRetestOf: null, isFixture: true };
const design = { suiteId: 'frozen-v1', versionLabel: 'v1', systemPrompt: null, referenceText: null };
const response = (text = 'WRONG') => ({ ok: true as const, text, latencyMs: 1 });
const accepted = () => ({ verdicts: makeScenarios().map(s => ({ scenarioId: s.id, accepted: true, reasons: [] as string[] })) });
const investigator = () => ({ reproduceScenarioIds: ['S01', 'S02', 'S03'], verdicts: ['S01', 'S02', 'S03'].map(id => ({ candidateId: `text:${id}:${id}.o1`, verdict: 'confirmed', rationale: 'Repeated explicit constraint violation.', quote: 'WRONG', defectNote: null })) });

describe('text integration: real SQL, fake provider, Workflow replay', () => {
  let engine: PGlite;
  let db: AgentTransactionalSql;
  beforeAll(async () => {
    engine = new PGlite();
    await engine.exec(readFileSync(new URL('../../agents/persistence-migrations/001-agent-persistence.sql', import.meta.url), 'utf8'));
    await engine.exec(readFileSync(new URL('./migrations/001-text-integration.sql', import.meta.url), 'utf8'));
    db = {
      query: <T>(sql: string, params?: unknown[]) => engine.query<T>(sql, params),
      transaction: fn => engine.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })),
    };
  }, 30_000);
  afterAll(async () => { await engine.close(); });
  // Separate durable job identities allow every test to retain real rows without coupling.
  let seq = 0;
  beforeEach(() => { seq++; });

  function setup(options: { target?: TextTargetPort; judge?: RubricJudge; checkpoints?: TextCheckpointStore; badDraft?: boolean; factualDraft?: boolean; pendingDraft?: boolean; pausedReview?: boolean; denied?: boolean } = {}) {
    const currentJob = { ...job, jobId: `${job.jobId}-${seq}` };
    const h = harness(body => ({ ...(options.pendingDraft && body.metadata.ae_output === 'text_design' ? { pollsUntilDone: 65 } : {}), ...(options.pausedReview && body.metadata.ae_output === 'text_review' ? { stopReason: 'budget_paused' as const } : {}), structuredOutput: body.metadata.ae_output === 'text_design' ? { scenarios: options.badDraft ? [] : options.factualDraft ? makeScenarios().map(s => ({ ...s, rubricChecks: [{ id: `${s.id}.r1`, kind: 'rubric', description: 'Answer accuracy', rubric: 'Factual claims must be supported by the reference.', assessesFactualCorrectness: true, requiresReference: true }] })) : makeScenarios() } : body.metadata.ae_output === 'text_review' ? accepted() : investigator() }), {
      store: new PostgresAgentTaskStore(db), ledger: new PostgresBudgetLedger(db),
    });
    const costs = new Map<string, unknown>();
    const recordCost = vi.fn(async (cost: Parameters<ServiceContext['recordCost']>[0]) => { costs.set(String(cost.meta?.idempotencyKey), cost); });
    const ctx: ServiceContext = { jobId: currentJob.jobId, environment: 'test', budgetMicroUsd: 1_000_000, recordCost, recordProgress: vi.fn(async () => {}) };
    const send = vi.fn(async () => response());
    let targetVersion = 'target-v1';
    const checkpoints = options.checkpoints ?? new PostgresTextCheckpointStore(db);
    const deps = { runner: h.service, checkpoints,
      async resolve() { if (options.denied) throw new Error('authorization_denied'); return { job: currentJob, target: options.target ?? { send }, targetVersion, judge: options.judge ?? null }; },
      clock: h.clock,
    };
    const restart = () => createTextEvaluationServices({ ...deps, runner: new AgentSessionService({ ...h.deps, workerId: 'restarted', store: new PostgresAgentTaskStore(db), ledger: new PostgresBudgetLedger(db) }), checkpoints: options.checkpoints ?? new PostgresTextCheckpointStore(db) });
    return { api: createTextEvaluationServices(deps), restart, h, ctx, send, costs, recordCost, currentJob, setVersion: (v: string) => { targetVersion = v; } };
  }

  it('designs, freezes, executes, investigates, reports and reruns from durable SQL with no replay dispatch', async () => {
    const f = setup();
    const outcome = await f.api.designSuite(f.ctx, design);
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('design blocked');
    const suite = outcome.suite;
    expect(suite.scenarios).toHaveLength(12);
    expect(f.h.naive.createCalls).toHaveLength(2);
    const designReplay = await f.restart().designSuite(f.ctx, design);
    expect(designReplay).toEqual(outcome);
    expect(await f.restart().getSuite(f.ctx, suite.digest)).toEqual(suite);
    expect(f.h.naive.createCalls).toHaveLength(2);
    expect(f.costs.size).toBe(2);

    const request = { suiteDigest: suite.digest, runId: 'baseline' };
    const run = await f.api.runSuite(f.ctx, request);
    expect(run.executions).toHaveLength(12);
    expect(run.executions.every(e => e.checks[0].status === 'fail')).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(12);
    expect(await f.restart().runSuite(f.ctx, request)).toEqual(run);
    expect(f.send).toHaveBeenCalledTimes(12);
    expect(toLegacyRunResult(run).results.every(r => r.passed === false)).toBe(true);

    const reviewed = await f.api.investigate(f.ctx, request);
    expect(reviewed.reproductions).toHaveLength(3);
    expect(reviewed.findings.filter(finding => finding.label === 'confirmed')).toHaveLength(3);
    expect(f.send).toHaveBeenCalledTimes(15);
    expect(await f.restart().investigate(f.ctx, request)).toEqual(reviewed);
    expect(f.send).toHaveBeenCalledTimes(15);
    expect(f.h.naive.createCalls).toHaveLength(3);
    expect(f.costs.size).toBe(3);
    const report = await f.restart().reportInput(f.ctx, request);
    expect(report.run).toEqual(run);
    expect(report.richFindings).toEqual(reviewed.findings);
    expect(report.suite).toEqual(suite);
    const rendered = await createTrackBServices({ runner: f.h.service, resolveJob: async () => f.currentJob, operatorSummary: false }).renderReport(f.ctx, {
      intake: { package: 'text_eval', endpoint: { url: 'https://fixture.invalid/v1', model: 'fake', systemPrompt: '' }, authorizedToTest: true },
      findings: [], richFindings: report.richFindings, limitations: report.limitations,
    });
    expect(rendered.markdown).toContain('WRONG');
    expect(rendered.findings.filter(finding => finding.status === 'confirmed')).toHaveLength(3);
    expect(rendered.html.length).toBeGreaterThan(0);

    const before = JSON.stringify(run);
    const rerun = await f.api.rerun(f.ctx, { suiteDigest: suite.digest, baselineRunId: 'baseline', runId: 'after' });
    expect(rerun.suiteDigest).toBe(suite.digest);
    expect(rerun.executions.every(e => e.attempt === 'rerun')).toBe(true);
    expect(JSON.stringify(run)).toBe(before);
    expect(f.send).toHaveBeenCalledTimes(27);
    expect(await f.restart().rerun(f.ctx, { suiteDigest: suite.digest, baselineRunId: 'baseline', runId: 'after' })).toEqual(rerun);
    expect(f.send).toHaveBeenCalledTimes(27);
    await expect(f.api.rerun(f.ctx, { suiteDigest: suite.digest, baselineRunId: 'baseline', runId: 'baseline' })).rejects.toThrow();
  });

  it('retains a new-policy factual gap across restart without reinterpreting a legacy design', async () => {
    const f = setup({ factualDraft: true });
    const legacy = await f.api.designSuite(f.ctx, design);
    expect(legacy.status).toBe('completed');
    const request = { ...design, suiteId: 'factual-gap-v1', factualGapPolicy: 'propose_missing_reference.v1' as const };
    const gap = await f.api.designSuite(f.ctx, request);
    expect(gap).toMatchObject({ status: 'blocked', reason: 'factual_reference_required', factualGap: { authority: 'model_proposed_coverage_requires_owner_validation' } });
    const dispatched = f.h.naive.createCalls.length;
    expect(await f.restart().designSuite(f.ctx, request)).toEqual(gap);
    expect(await f.restart().designSuite(f.ctx, design)).toEqual(legacy);
    expect(f.h.naive.createCalls).toHaveLength(dispatched);
    await expect(f.restart().designSuite(f.ctx, { ...design, factualGapPolicy: request.factualGapPolicy })).rejects.toThrow('identity_conflict');
    expect(f.send).not.toHaveBeenCalled();
  });

  it('holds a safely undispatched judge and resumes without replaying the retained target', async () => {
    let waiting = true;
    const judge = vi.fn<RubricJudge>(async input => {
      if (waiting) throw new NaiveProxyJudgePendingError(input.operationId, 1, 'budget_denied');
      return { outcome: 'passed', explanation: 'Reference supports the answer.', evidenceQuotes: [] };
    });
    const f = setup({ factualDraft: true, judge });
    const designed = await f.api.designSuite(f.ctx, { ...design, referenceText: 'Trusted reference.' });
    if (designed.status !== 'completed') throw Error('design blocked');
    const request = { suiteDigest: designed.suite.digest, runId: 'judge-pending', scenarioIds: ['S01'] };
    await expect(f.api.runSuite(f.ctx, request)).rejects.toMatchObject({ retryAfterMs: 5000 });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect((await db.query("SELECT 1 FROM text_integration.checkpoints WHERE job_id=$1 AND kind='run_result'", [f.ctx.jobId])).rows).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM text_integration.checkpoints WHERE job_id=$1 AND kind='judge' AND state='completed'", [f.ctx.jobId])).rows).toHaveLength(0);
    waiting = false;
    const run = await f.restart().runSuite(f.ctx, request);
    expect(run.executions[0].checks.some(c => c.kind === 'rubric' && c.status === 'pass')).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(await f.restart().runSuite(f.ctx, request)).toEqual(run);
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('holds unknown judge state without caching an inconclusive run and can read a reconciled receipt', async () => {
    let unknown = true;
    const judge = vi.fn<RubricJudge>(async input => {
      if (unknown) throw new NaiveProxyJudgeReconciliationRequiredError(input.operationId);
      return { outcome: 'passed', explanation: 'Reconciled retained receipt.', evidenceQuotes: [] };
    });
    const f = setup({ factualDraft: true, judge });
    const designed = await f.api.designSuite(f.ctx, { ...design, referenceText: 'Trusted reference.' });
    if (designed.status !== 'completed') throw Error('design blocked');
    const request = { suiteDigest: designed.suite.digest, runId: 'judge-unknown', scenarioIds: ['S01'] };
    await expect(f.api.runSuite(f.ctx, request)).rejects.toMatchObject({ code: 'needs_operator' });
    expect((await db.query("SELECT 1 FROM text_integration.checkpoints WHERE job_id=$1 AND kind='run_result'", [f.ctx.jobId])).rows).toHaveLength(0);
    unknown = false;
    const run = await f.restart().runSuite(f.ctx, request);
    expect(run.executions[0].checks.some(c => c.kind === 'rubric' && c.status === 'pass')).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('retains the investigator task while a reproduction judge requires recovery', async () => {
    let waiting = false;
    const judge: RubricJudge = async input => {
      if (waiting) throw new NaiveProxyJudgePendingError(input.operationId, 1, 'undispatched_recovery_required');
      return { outcome: 'passed', explanation: 'Reference supports the answer.', evidenceQuotes: [] };
    };
    const f = setup({ factualDraft: true, judge });
    const designed = await f.api.designSuite(f.ctx, { ...design, referenceText: 'Trusted reference.' });
    if (designed.status !== 'completed') throw Error('design blocked');
    const request = { suiteDigest: designed.suite.digest, runId: 'investigator-pending' };
    await f.api.runSuite(f.ctx, request);
    const tasks = f.h.naive.createCalls.length;
    waiting = true;
    await expect(f.api.investigate(f.ctx, request)).rejects.toMatchObject({ retryAfterMs: 5000 });
    expect(f.h.naive.createCalls).toHaveLength(tasks + 1);
    expect(f.send).toHaveBeenCalledTimes(13);
    waiting = false;
    const investigation = await f.restart().investigate(f.ctx, request);
    expect(investigation.investigatorStatus).toBe('completed');
    expect(f.send).toHaveBeenCalledTimes(15);
    expect(f.h.naive.createCalls).toHaveLength(tasks + 1);
  });

  it('binds design and run identity to immutable inputs and resolved target versions', async () => {
    const f = setup(); const o = await f.api.designSuite(f.ctx, design);
    if (o.status !== 'completed') throw new Error('design blocked');
    await expect(f.restart().designSuite(f.ctx, { ...design, referenceText: 'changed' })).rejects.toThrow();
    await f.api.runSuite(f.ctx, { suiteDigest: o.suite.digest, runId: 'identity', scenarioIds: ['S01'] });
    await expect(f.restart().runSuite(f.ctx, { suiteDigest: o.suite.digest, runId: 'identity', scenarioIds: ['S02'] })).rejects.toThrow();
    f.setVersion('target-v2');
    await expect(f.restart().runSuite(f.ctx, { suiteDigest: o.suite.digest, runId: 'identity', scenarioIds: ['S01'] })).rejects.toThrow();
    await expect(f.restart().investigate(f.ctx, { suiteDigest: o.suite.digest, runId: 'identity' })).rejects.toThrow('original run target version');
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('refuses unauthorized design before any agent or target dispatch', async () => {
    const f = setup({ denied: true });
    await expect(f.api.designSuite(f.ctx, design)).rejects.toThrow('authorization_denied');
    expect(f.h.naive.createCalls).toHaveLength(0); expect(f.send).not.toHaveBeenCalled();
  });

  it('records measured costs for blocked output once under repeated delivery', async () => {
    const f = setup({ badDraft: true });
    const outcome = await f.api.designSuite(f.ctx, design);
    expect(outcome.status).toBe('blocked');
    expect(f.costs.size).toBe(1);
    await f.restart().designSuite(f.ctx, design);
    expect(f.h.naive.createCalls).toHaveLength(1);
    expect(f.costs.size).toBe(1);
    const entry = [...f.costs.values()][0] as { microUsd: number; meta: { measured: boolean } };
    expect(entry.microUsd).toBe(12_345); expect(entry.meta.measured).toBe(true);
  });

  it('resumes a pending agent session rather than dispatching another design attempt', async () => {
    const f = setup({ pendingDraft: true });
    const pending = await f.api.designSuite(f.ctx, design);
    expect(pending).toMatchObject({ status: 'blocked', reason: 'pending' });
    expect(f.h.naive.createCalls).toHaveLength(1);
    expect(f.costs.size).toBe(0);
    const completed = await f.restart().designSuite(f.ctx, design);
    expect(completed.status).toBe('completed');
    expect(f.h.naive.createCalls).toHaveLength(2);
    expect(f.costs.size).toBe(2);
  });

  it('preserves both measured sessions when engineer succeeds and review pauses for budget', async () => {
    const f = setup({ pausedReview: true });
    const outcome = await f.api.designSuite(f.ctx, design);
    expect(outcome).toMatchObject({ status: 'blocked', reason: 'budget_paused' });
    expect(f.costs.size).toBe(2);
    expect([...f.costs.keys()].every(key => key.startsWith('naive:ses_fake_'))).toBe(true);
    await f.restart().designSuite(f.ctx, design);
    expect(f.costs.size).toBe(2); expect(f.h.naive.createCalls).toHaveLength(2);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('replays a measured cost after its sink commits but loses the acknowledgement', async () => {
    const f = setup();
    let delivered = false;
    const durableSink = f.ctx.recordCost;
    f.ctx.recordCost = async cost => {
      await durableSink(cost);
      if (!delivered) { delivered = true; throw new Error('cost acknowledgement lost'); }
    };
    await expect(f.api.designSuite(f.ctx, design)).rejects.toThrow('cost acknowledgement lost');
    expect(f.costs.size).toBe(1);
    const resumed = await f.restart().designSuite(f.ctx, design);
    expect(resumed.status).toBe('completed');
    expect(f.h.naive.createCalls).toHaveLength(2);
    expect(f.costs.size).toBe(2);
    expect(await f.restart().designSuite(f.ctx, design)).toEqual(resumed);
    expect(f.h.naive.createCalls).toHaveLength(2);
    expect(f.costs.size).toBe(2);
  });

  it('legacy conversion refuses execution gaps instead of inventing boolean failures', async () => {
    const f = setup(); const o = await f.api.designSuite(f.ctx, design);
    if (o.status !== 'completed') throw new Error('design blocked');
    const run = await f.api.runSuite(f.ctx, { suiteDigest: o.suite.digest, runId: 'unknown-projection', scenarioIds: ['S01'] });
    const unknown = structuredClone(run);
    unknown.executions[0].checks[0] = { ...unknown.executions[0].checks[0], status: 'inconclusive', reason: 'check_error' };
    expect(() => toLegacyRunResult(unknown)).toThrow();
    unknown.executions[0].outcome = 'infrastructure_error';
    expect(() => toLegacyRunResult(unknown)).toThrow();
    const concern = structuredClone(run);
    concern.executions[0].checks[0] = { ...concern.executions[0].checks[0], kind: 'rubric', status: 'concern' };
    expect(() => toLegacyRunResult(concern)).toThrow();
  });

  it('keeps a lost external response pending/operator across restarts, without blindly resending', async () => {
    const send = vi.fn(async () => { throw new Error('lost response with private provider body'); });
    const f = setup({ target: { send } });
    const o = await f.api.designSuite(f.ctx, design);
    if (o.status !== 'completed') throw new Error('design blocked');
    const request = { suiteDigest: o.suite.digest, runId: 'ambiguous', scenarioIds: ['S01'] };
    await expect(f.api.runSuite(f.ctx, request)).rejects.toThrow();
    await expect(f.restart().runSuite(f.ctx, request)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('preserves partial scenarios when the response arrives but its durable acknowledgement is lost', async () => {
    const base = new PostgresTextCheckpointStore(db);
    let targetWrites = 0;
    const checkpoints: TextCheckpointStore = {
      claim: key => base.claim(key), get: key => base.get(key), release: (key, token) => base.release(key, token),
      markAmbiguous: (key, token) => base.markAmbiguous(key, token),
      async complete(key, token, value) {
        if (key.kind === 'target' && ++targetWrites === 2) throw new Error('lost durable response write');
        return base.complete(key, token, value);
      },
    };
    const f = setup({ checkpoints }); const o = await f.api.designSuite(f.ctx, design);
    if (o.status !== 'completed') throw new Error('design blocked');
    const request = { suiteDigest: o.suite.digest, runId: 'partial-write', scenarioIds: ['S01', 'S02', 'S03'] };
    await expect(f.api.runSuite(f.ctx, request)).rejects.toThrow();
    expect(f.send).toHaveBeenCalledTimes(2);
    await expect(f.restart().runSuite(f.ctx, request)).rejects.toThrow();
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it('stops after a lost reproduction response and never repeats any investigation target call', async () => {
    const send = vi.fn(async (request: Parameters<TextTargetPort['send']>[0]) => {
      if (request.runId.startsWith('repro:') && request.scenarioId === 'S02') throw new Error('lost reproduction response');
      return response();
    });
    const f = setup({ target: { send } });
    const o = await f.api.designSuite(f.ctx, design);
    if (o.status !== 'completed') throw new Error('design blocked');
    const request = { suiteDigest: o.suite.digest, runId: 'investigation-ambiguity' };
    await f.api.runSuite(f.ctx, request);
    await expect(f.api.investigate(f.ctx, request)).rejects.toThrow();
    const calls = send.mock.calls.length;
    expect(calls).toBe(14);
    expect(f.costs.size).toBe(3);
    await expect(f.restart().investigate(f.ctx, request)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(calls);
    expect(f.h.naive.createCalls).toHaveLength(3);
    await expect(f.restart().reportInput(f.ctx, request)).rejects.toThrow();
  });

  it('interleaved callers share a SQL claim and never issue a duplicate target request', async () => {
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const send = vi.fn(async () => { started(); await gate; return response('READY'); });
    const f = setup({ target: { send } });
    const o = await f.api.designSuite(f.ctx, design);
    if (o.status !== 'completed') throw new Error('design blocked');
    const request = { suiteDigest: o.suite.digest, runId: 'race', scenarioIds: ['S01'] };
    const first = f.api.runSuite(f.ctx, request);
    await entered;
    await expect(f.restart().runSuite(f.ctx, request)).rejects.toThrow();
    expect(send).toHaveBeenCalledTimes(1);
    finish();
    const completed = await first;
    expect(await f.restart().runSuite(f.ctx, request)).toEqual(completed);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

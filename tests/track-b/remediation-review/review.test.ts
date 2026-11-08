import { createTextTarget } from '../targets/text';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentTransactionalSql } from '../agents/postgres-ports';
import type { AgentTaskRunner } from '../agents/session-service';
import type { ServiceContext } from '../contracts/services';
import { PostgresTextCheckpointStore } from '../evals/integration/checkpoints';
import { executeSuite, evaluateObjectiveCheck, freezeSuite } from '../evals/text';
import { makeSuite } from '../evals/text/__tests__/fixtures';
import type { CostEntry, Finding, JobRef } from '../evals/types';
import { createRemediationServices, type AuthorizedRemediation, type Patch } from '../evals/remediation/index';

const patch: Patch = { kind: 'prompt_patch', summary: 'Honor the required marker.', patch: 'Follow the explicit user constraints. Always include READY.', rationale: 'Correct the observed failure while preserving original checks.' };
const response = (text: string) => ({ ok: true as const, text, latencyMs: 1 });

describe('remediation: SQL persistence and offline isolated target trials', () => {
  let engine: PGlite;
  let db: AgentTransactionalSql;
  let seq = 0;
  beforeAll(async () => {
    engine = new PGlite();
    await engine.exec(readFileSync(new URL('../evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
    db = { query: <T>(sql: string, params?: unknown[]) => engine.query<T>(sql, params), transaction: fn => engine.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })) };
  }, 30_000);
  afterAll(async () => { await engine.close(); });

  async function fixture(options: { text?: (scenarioId: string) => string; noApply?: boolean; rubric?: 'inconclusive' | 'no_reference'; throwing?: boolean; patch?: Patch; trace?: boolean; paidTarget?: boolean } = {}) {
    const job: JobRef = { jobId: `remediation-${++seq}`, customerId: 'fixture-customer', package: options.trace ? 'trace_audit' : 'text_eval', environment: 'test', quoteVersion: null, linkedRetestOf: null, isFixture: true };
    let suite = makeSuite({ jobId: job.jobId });
    if (options.rubric) {
      const { digest: _, ...body } = suite;
      body.referenceText = options.rubric === 'no_reference' ? null : 'READY is required.';
      body.scenarios = body.scenarios.map(s => ({ ...s, rubricChecks: [{ id: `${s.id}.r1`, kind: 'rubric' as const, description: 'Factual accuracy', rubric: 'Judge factual correctness and absence of fabrication against the reference.', assessesFactualCorrectness: true }] }));
      suite = freezeSuite(body);
    }
    const baseline = await executeSuite(suite, 'baseline', { target: { send: async r => response(r.scenarioId === 'S01' ? 'WRONG' : 'READY') }, judge: async () => ({ outcome: 'passed', explanation: 'Supported.', evidenceQuotes: [] }), evaluateObjective: evaluateObjectiveCheck });
    const finding: Finding = { id: 'finding-1', source: options.trace ? 'trace_audit' : 'text_eval', category: 'instruction_violation', title: 'Required marker absent', label: 'confirmed', severity: 'medium', basis: 'objective', summary: 'The original S01 response omitted READY.', evidence: [{ kind: 'check', checkId: 'S01.o1', detail: 'Required marker missing.' }, { kind: 'scenario_response', scenarioId: 'S01', runId: 'baseline', quote: 'WRONG', truncated: false }], investigatorNote: null, reproduction: null };
    const cost = (id: string): CostEntry => ({ jobId: job.jobId, source: 'naive_session', role: 'evaluation_engineer', externalId: id, purpose: 'remediation', microUsd: 7, measured: true, recordedAt: '2026-11-07T20:00:00.000Z' });
    const run = vi.fn(async () => ({ status: 'completed', taskKey: `${job.jobId}:engineer`, output: options.patch ?? patch, session: { sessionId: `${job.jobId}-session`, agentId: 'engineer', agentVersion: 1, consumedMicroUsd: 7, tokenUsage: {} }, cost: cost(`${job.jobId}-session`) }));
    const sink = new Map<string, unknown>();
    let loseAck = false;
    const recordCost = vi.fn(async (c: Parameters<ServiceContext['recordCost']>[0]) => { sink.set(String(c.meta.idempotencyKey), c); if (loseAck) { loseAck = false; throw new Error('lost cost acknowledgement'); } });
    const ctx: ServiceContext = { jobId: job.jobId, environment: 'test', budgetMicroUsd: 1_000_000, recordCost, recordProgress: async () => {} };
    const binding = { targetId: 'isolated-fixture', targetVersion: 'v1', environment: 'test' as const };
    const send = vi.fn<NonNullable<AuthorizedRemediation['trial']>['send']>(async input => {
      if (options.throwing) throw new Error('lost target response');
      return { value: { response: response(options.text?.(input.request.scenarioId) ?? (input.request.systemPrompt === patch.patch ? 'READY' : 'WRONG')), receipt: { ...binding, isolated: true, trialId: `${job.jobId}-trial`, baselineRunId: input.baselineRunId, suiteDigest: input.suiteDigest, runId: input.request.runId, scenarioId: input.request.scenarioId, patchDigest: input.patchDigest, actualSystemPrompt: options.noApply ? suite.systemPrompt! : input.request.systemPrompt! } }, costs: options.paidTarget ? [cost(`${job.jobId}-target-${input.request.scenarioId}`)] : [] };
    });
    const authorize = vi.fn(async () => true);
    const judge = vi.fn<NonNullable<AuthorizedRemediation['judge']>>(async () => ({ value: { outcome: options.rubric === 'inconclusive' ? 'inconclusive' : 'passed', explanation: 'Offline judge.', evidenceQuotes: [] }, costs: [] }));
    const authorized: AuthorizedRemediation = { job, finding, knownSecrets: [], binding, original: options.trace ? null : { suite, run: baseline, binding, failingCheckIds: ['S01.o1'] }, trial: options.trace ? null : { trialId: `${job.jobId}-trial`, send }, judge, authorize };
    const resolve = vi.fn(async () => authorized);
    const restart = () => createRemediationServices({ runner: { run } as unknown as AgentTaskRunner, checkpoints: new PostgresTextCheckpointStore(db), resolve });
    const call = () => restart().proposeAndVerifyFixDetailed(ctx, { findingId: finding.id });
    return { cost, call, restart, ctx, authorized, suite, baseline, send, run, judge, authorize, resolve, sink, recordCost, loseNextCostAcknowledgement: () => { loseAck = true; } };
  }

  it('positive control: all twelve actual prompt-sensitive calls retain exact original inputs and checks', async () => {
    const f = await fixture();
    const before = JSON.stringify(f.authorized.original);
    const result = await f.call();
    expect(result.remediation.verification.status).toBe('verified');
    expect(result.executions.map(e => e.scenarioId)).toEqual(f.suite.scenarios.map(s => s.id));
    for (const [input] of f.send.mock.calls) {
      expect(input.request.systemPrompt).toBe(patch.patch);
      expect(input.request.userMessage).toBe(f.suite.scenarios.find(s => s.id === input.request.scenarioId)!.userMessage);
      expect(input.suiteDigest).toBe(f.suite.digest);
      expect(input.baselineRunId).toBe(f.baseline.runId);
    }
    expect(JSON.stringify(f.authorized.original)).toBe(before);
  });

  it.each(['targetId', 'targetVersion', 'environment', 'trialId', 'baselineRunId', 'suiteDigest', 'runId', 'scenarioId', 'patchDigest', 'actualSystemPrompt', 'isolated'] as const)
  ('rejects verification for a mismatched receipt field: %s', async field => {
    const f = await fixture();
    f.authorized.trial!.send = async input => {
      const result = await f.send(input);
      Object.assign(result.value.receipt, { [field]: field === 'isolated' ? false : 'different' });
      return result;
    };
    const result = await f.call();
    expect(result.remediation.verification.after.passed).toBe(12);
    expect(result.remediation.verification.status).toBe('not_verified');
    expect(result.reason).toContain('application was not established');
  });

  it.each(['missing_scenario', 'duplicate_scenario', 'missing_check', 'wrong_run', 'wrong_suite', 'wrong_version', 'not_failed'] as const)
  ('rejects malformed original coverage or identity before paid work: %s', async kind => {
    const f = await fixture();
    const run = f.authorized.original!.run;
    if (kind === 'missing_scenario') run.executions.pop();
    if (kind === 'duplicate_scenario') run.executions[11] = run.executions[0]!;
    if (kind === 'missing_check') run.executions[0]!.checks = [];
    if (kind === 'wrong_run') run.executions[0]!.runId = 'other';
    if (kind === 'wrong_suite') run.suiteDigest = 'a'.repeat(64);
    if (kind === 'wrong_version') run.versionLabel = 'other';
    if (kind === 'not_failed') run.executions[0]!.checks[0]!.status = 'pass';
    await expect(f.call()).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

  it('does not verify a baseline containing an unassessed unrelated check', async () => {
    const f = await fixture();
    f.authorized.original!.run.executions[1]!.checks[0]!.status = 'not_assessed';
    const result = await f.call();
    expect(result.remediation.verification.after.passed).toBe(12);
    expect(result.remediation.verification.status).toBe('not_verified');
  });

  it('retains target infrastructure errors and measured costs across restart', async () => {
    const f = await fixture({ paidTarget: true });
    f.authorized.trial!.send = async input => {
      const result = await f.send(input);
      return { ...result, value: { ...result.value, response: { ok: false, errorCode: 'offline', message: 'definitive failure', latencyMs: 1 } } };
    };
    const result = await f.call();
    expect(result.executions.every(e => e.outcome === 'infrastructure_error' && e.checks.every(c => c.status === 'inconclusive'))).toBe(true);
    expect(result.remediation.verification).toMatchObject({ status: 'not_verified', regressions: 11 });
    expect(f.sink.size).toBe(13);
    expect(await f.call()).toEqual(result);
    expect(f.send).toHaveBeenCalledTimes(12);
  });

  it('requires current resolver authorization even on a completed replay', async () => {
    const f = await fixture(); await f.call();
    f.resolve.mockRejectedValue(new Error('caller no longer authorized'));
    await expect(f.call()).rejects.toThrow('caller no longer authorized');
    expect(f.send).toHaveBeenCalledTimes(12); expect(f.run).toHaveBeenCalledTimes(1);
  });

  it('writes intent before authorization; ambiguous authorization never dispatches or retries', async () => {
    const f = await fixture();
    f.authorized.authorize = async ({ operationId, inputDigest }) => {
      const rows = await engine.query<{ state: string; input_digest: string }>('SELECT state, input_digest FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2', [f.ctx.jobId, 'remediation_target']);
      expect(rows.rows).toEqual([{ state: 'pending', input_digest: inputDigest }]);
      expect(operationId).toContain(f.ctx.jobId);
      f.authorize();
      throw new Error('reservation acknowledgement lost');
    };
    await expect(f.call()).rejects.toThrow(); await expect(f.call()).rejects.toThrow();
    expect(f.authorize).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled();
    expect(f.sink.size).toBe(1);
  });

  it('judge denial blocks after recording target usage; replay never repeats the target', async () => {
    const f = await fixture({ rubric: 'inconclusive', paidTarget: true });
    f.authorized.authorize = async ({ kind }) => kind === 'target';
    await expect(f.call()).rejects.toThrow(); await expect(f.call()).rejects.toThrow();
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.judge).not.toHaveBeenCalled(); expect(f.sink.size).toBe(2);
  });

  it('judge secret refusal persists only marker and costs, then blocks on replay', async () => {
    const f = await fixture({ rubric: 'inconclusive', paidTarget: true });
    f.authorized.knownSecrets = ['opaque-judge-value'];
    f.judge.mockResolvedValue({ value: { outcome: 'passed', explanation: 'opaque-judge-value', evidenceQuotes: [] }, costs: [f.cost('judge-session')] });
    await expect(f.call()).rejects.toThrow(); await expect(f.call()).rejects.toThrow();
    expect(f.send).toHaveBeenCalledTimes(1); expect(f.judge).toHaveBeenCalledTimes(1); expect(f.sink.size).toBe(3);
    const rows = await engine.query('SELECT value FROM text_integration.checkpoints WHERE job_id=$1', [f.ctx.jobId]);
    expect(JSON.stringify(rows.rows)).not.toContain('opaque-judge-value');
  });

  it('secret proposal persists only refusal and measured cost, with no target execution', async () => {
    const f = await fixture({ patch: { ...patch, patch: 'opaque-proposal-value' } });
    f.authorized.knownSecrets = ['opaque-proposal-value'];
    await expect(f.call()).rejects.toThrow(); await expect(f.call()).rejects.toThrow();
    expect(f.run).toHaveBeenCalledTimes(1); expect(f.send).not.toHaveBeenCalled(); expect(f.sink.size).toBe(1);
    const rows = await engine.query('SELECT value FROM text_integration.checkpoints WHERE job_id=$1', [f.ctx.jobId]);
    expect(JSON.stringify(rows.rows)).not.toContain('opaque-proposal-value');
  });

  // Desired security property intentionally fails with a lying privileged port.
  // This is NOT evidence of an untrusted caller exploit. Keep the limitation visible.
  it.fails('INTEGRATION GAP: an echoed receipt cannot prove actual application by a dishonest trusted port', async () => {
    const f = await fixture();
    let actuallyApplied = false;
    f.authorized.trial!.send = async input => {
      const result = await f.send(input);
      actuallyApplied = false; // no real configuration was applied
      return result; // passing canned output + requested-field echo
    };
    const result = await f.call();
    expect(actuallyApplied).toBe(false);
    console.warn('INTEGRATION GAP: privileged fabricated receipt produced', result.remediation.verification.status);
    expect(result.remediation.verification.status).toBe('not_verified');
  });
  it('positive control: actual text adapter sends the replacement prompt and original scenario to its transport', async () => {
    const f = await fixture();
    const bodies: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];
    const target = createTextTarget({ url: 'https://offline.invalid/v1/chat/completions', model: 'isolated-model', maxCompletionTokens: 64 }, {
      post: async (_url, raw) => {
        const body = raw as typeof bodies[number];
        bodies.push(body);
        const text = body.messages[0]!.content === patch.patch ? 'READY' : 'WRONG';
        return { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] };
      },
    });
    f.authorized.trial!.send = async input => {
      const envelope = await f.send(input);
      const response = await target.send(input.request);
      // This test adapter attests the actual outgoing body, not the requested string.
      envelope.value.receipt.actualSystemPrompt = bodies.at(-1)!.messages[0]!.content;
      return { ...envelope, value: { ...envelope.value, response } };
    };
    const result = await f.call();
    expect(result.remediation.verification.status).toBe('verified');
    expect(bodies).toHaveLength(12);
    for (const [i, body] of bodies.entries()) {
      expect(body.model).toBe('isolated-model');
      expect(body.messages).toEqual([{ role: 'system', content: patch.patch }, { role: 'user', content: f.suite.scenarios[i]!.userMessage }]);
    }
  });

  it('REGRESSION R1: an invalid initial budget does not permanently poison an unstarted remediation', async () => {
    const f = await fixture();
    f.ctx.budgetMicroUsd = 0;
    await expect(f.call()).rejects.toThrow('Positive bounded engineer budget required');
    expect(f.run).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    const rows = await engine.query<{ state: string }>('SELECT state FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2', [f.ctx.jobId, 'remediation_engineer_budget']);
    expect(rows.rows).toEqual([{ state: 'ready' }]);
    f.ctx.budgetMicroUsd = 1_000_000;
    // No paid action occurred, so corrected authorization may start safely.
    await expect(f.call()).resolves.toMatchObject({ remediation: { verification: { status: 'verified' } } });
  });

  it('failed engineer usage survives a lost sink acknowledgement and is redelivered before blocking', async () => {
    const f = await fixture();
    const run = vi.fn(async () => ({ status: 'failed' as const, taskKey: 'failed-engineer', code: 'failed', message: 'offline', session: null, cost: f.cost('failed-session') }));
    const call = () => createRemediationServices({ runner: { run }, checkpoints: new PostgresTextCheckpointStore(db), resolve: f.resolve }).proposeAndVerifyFixDetailed(f.ctx, { findingId: 'finding-1' });
    f.loseNextCostAcknowledgement();
    await expect(call()).rejects.toThrow('lost cost acknowledgement');
    await expect(call()).rejects.toThrow('Engineer proposal unavailable');
    expect(run).toHaveBeenCalledTimes(1); expect(f.recordCost).toHaveBeenCalledTimes(2);
    expect(f.sink.size).toBe(1); expect(f.send).not.toHaveBeenCalled();
  });

});

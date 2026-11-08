import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { createRemediationServices, remediationDigest, type AuthorizedRemediation, type Patch } from '../evals/remediation';
import { evaluateObjectiveCheck, executeSuite } from '../evals/text';
import { makeScenarios, makeSuite } from '../evals/text/__tests__/fixtures';
import { PostgresTextCheckpointStore } from '../evals/integration/checkpoints';
import type { AgentTransactionalSql } from '../agents/postgres-ports';
import type { AgentTaskRunner } from '../agents/session-service';
import type { ServiceContext } from '../contracts/services';
import { createRemediationTarget, type RemediationTargetScope, type RemediationTargetDeps } from './remediation';

type Input = Parameters<NonNullable<AuthorizedRemediation['trial']>['send']>[0];
const patch: Patch = { kind: 'prompt_patch', summary: 'Repair marker', patch: 'Always include READY.', rationale: 'Keep the original constraints.' };
const completion = { choices: [{ message: { role: 'assistant', content: 'READY' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
async function fixture() {
  const job: AuthorizedRemediation['job'] = { jobId: 'secured-target-job', customerId: 'tenant', package: 'text_eval', environment: 'test', quoteVersion: null, linkedRetestOf: null, isFixture: true };
  const suite = makeSuite({ jobId: job.jobId, scenarios: makeScenarios().map(s => ({ ...s, userMessage: `You answer questions about ${s.id}.\n${s.userMessage}` })) });
  const baseline = await executeSuite(suite, 'baseline', { target: { send: async r => ({ ok: true, text: r.scenarioId === 'S01' ? 'WRONG' : 'READY', latencyMs: 1 }) }, judge: null, evaluateObjective: evaluateObjectiveCheck });
  const binding = { targetId: 'canonical-target', targetVersion: 'model-config-v1', environment: 'test' as const };
  const finding: AuthorizedRemediation['finding'] = { id: 'confirmed-1', source: 'text_eval', category: 'instruction_violation', title: 'Marker missing', label: 'confirmed', severity: 'medium', basis: 'objective', summary: 'Missing READY', evidence: [{ kind: 'check', checkId: 'S01.o1', detail: 'Missing' }], investigatorNote: null, reproduction: null };
  const scope: RemediationTargetScope = { job, finding, binding, original: { suite, run: baseline, binding, failingCheckIds: ['S01.o1'] }, trialId: 'isolated-trial', endpoint: { kind: 'stateless_chat_completions', isolation: 'request_messages_only', url: 'https://example.com/v1/chat/completions', model: 'canonical-model', apiKey: 'fixture-credential' } };
  const root = remediationDigest({ finding, binding, original: scope.original, trialId: scope.trialId });
  const input: Input = { request: { runId: `rem-${root.slice(0, 48)}`, scenarioId: 'S01', systemPrompt: patch.patch, userMessage: suite.scenarios[0]!.userMessage }, patch: structuredClone(patch), patchDigest: remediationDigest(patch), baselineRunId: baseline.runId, suiteDigest: suite.digest };
  const post = vi.fn(async (_url: string, _body: unknown, _bearer?: string): Promise<unknown> => structuredClone(completion));
  const accounting = { beforeDispatch: vi.fn(async () => {}), observed: vi.fn(async () => {}), ambiguous: vi.fn(async () => {}) };
  const currentSecrets = vi.fn(async (): Promise<readonly string[]> => []);
  const deps: RemediationTargetDeps = { scope, currentSecrets, accounting, transport: { post }, limits: { timeoutMs: 1000, maxCompletionTokens: 128, maxRequestBytes: 256_000, maxResponseBytes: 100_000 } };
  return { scope, input, deps, post, accounting, currentSecrets };
}

describe('secured request-scoped remediation target', () => {
  it('composes actual text/chat serialization with the remediation factory for all twelve frozen scenarios and SQL replay', async () => {
    const f = await fixture();
    const frozen = JSON.stringify(f.scope.original);
    const trial = createRemediationTarget(f.deps);
    const authorized: AuthorizedRemediation = { job: f.scope.job, finding: f.scope.finding, binding: f.scope.binding, original: f.scope.original, knownSecrets: [], trial, judge: null, authorize: vi.fn(async () => true) };
    const db = new PGlite();
    try {
      await db.exec(readFileSync(new URL('../evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
      const sql: AgentTransactionalSql = { query: (s, p) => db.query(s, p), transaction: fn => db.transaction(tx => fn({ query: (s, p) => tx.query(s, p) })) };
      const ctx: ServiceContext = { jobId: f.scope.job.jobId, environment: 'test', budgetMicroUsd: 1000, recordCost: async () => {}, recordProgress: async () => {} };
      const runner = { run: vi.fn(async () => ({ status: 'completed', output: patch })) } as unknown as AgentTaskRunner;
      const factory = () => createRemediationServices({ runner, checkpoints: new PostgresTextCheckpointStore(sql), resolve: async () => authorized });
      const first = await factory().proposeAndVerifyFixDetailed(ctx, { findingId: f.scope.finding.id });
      expect(first.remediation.verification).toMatchObject({ status: 'verified', before: { passed: 11, total: 12 }, after: { passed: 12, total: 12 } });
      expect(first.applied).toHaveLength(12);
      expect(f.post).toHaveBeenCalledTimes(12);
      for (const [i, [url, body, bearer]] of f.post.mock.calls.entries()) {
        const scenario = f.scope.original.suite.scenarios[i]!;
        expect(url).toBe(f.scope.endpoint.url); expect(bearer).toBe('fixture-credential');
        expect(body).toEqual({ model: 'canonical-model', store: false, max_completion_tokens: 128, messages: [{ role: 'system', content: patch.patch }, { role: 'user', content: scenario.userMessage }] });
        expect(Object.isFrozen(body)).toBe(true);
        expect(first.applied[i]).toEqual({ ...f.scope.binding, isolated: true, trialId: f.scope.trialId, baselineRunId: 'baseline', suiteDigest: f.scope.original.suite.digest, runId: first.freshRunId, scenarioId: scenario.id, patchDigest: remediationDigest(patch), actualSystemPrompt: (body as { messages: { content: string }[] }).messages[0]!.content });
        expect(f.accounting.beforeDispatch.mock.invocationCallOrder[i]).toBeLessThan(f.post.mock.invocationCallOrder[i]!);
      }
      expect(f.accounting.observed.mock.calls[0]).toEqual([expect.objectContaining({ payloadDigest: remediationDigest(f.post.mock.calls[0]![1]), runId: first.freshRunId }), { promptTokens: 10, completionTokens: 2, totalTokens: 12 }]);
      expect(JSON.stringify(f.scope.original)).toBe(frozen);
      expect(await factory().proposeAndVerifyFixDetailed({ ...ctx, budgetMicroUsd: 0 }, { findingId: f.scope.finding.id })).toEqual(first);
      expect(f.post).toHaveBeenCalledTimes(12);
    } finally { await db.close(); }
  }, 30_000);

  it.each(['user', 'prompt', 'digest', 'patch', 'scenario', 'run', 'baseline', 'suite'] as const)('rejects mismatched %s before dispatch', async field => {
    const f = await fixture(), input = structuredClone(f.input);
    if (field === 'user') input.request.userMessage += ' altered';
    if (field === 'prompt') input.request.systemPrompt = 'different';
    if (field === 'digest') input.patchDigest = '0'.repeat(64);
    if (field === 'patch') input.patch.summary += ' changed';
    if (field === 'scenario') input.request.scenarioId = 'unknown';
    if (field === 'run') input.request.runId = 'arbitrary-run';
    if (field === 'baseline') input.baselineRunId = 'other-baseline';
    if (field === 'suite') input.suiteDigest = 'other-suite';
    await expect(createRemediationTarget(f.deps).send(input)).rejects.toThrow('remediation_target_unresolved');
    expect(f.post).not.toHaveBeenCalled(); expect(f.accounting.beforeDispatch).not.toHaveBeenCalled();
  });
  it.each(['version', 'environment', 'target', 'trial', 'finding'] as const)('rejects cross-%s run identity', async field => {
    const f = await fixture();
    if (field === 'version') f.scope.binding = { ...f.scope.binding, targetVersion: 'v2' };
    if (field === 'target') f.scope.binding = { ...f.scope.binding, targetId: 'other' };
    if (field === 'environment') { f.scope.binding = { ...f.scope.binding, environment: 'live' }; f.scope.job.environment = 'live'; }
    f.scope.original.binding = { ...f.scope.binding };
    if (field === 'trial') f.scope.trialId = 'other';
    if (field === 'finding') f.scope.finding.id = 'other';
    await expect(createRemediationTarget(f.deps).send(f.input)).rejects.toThrow();
    expect(f.post).not.toHaveBeenCalled();
  });
  it('detaches canonical configuration from later caller mutation', async () => {
    const f = await fixture(), target = createRemediationTarget(f.deps);
    f.scope.endpoint.url = 'https://other.example/'; f.scope.endpoint.model = 'different';
    f.scope.original.suite.scenarios[0]!.userMessage = 'changed'; f.scope.binding.targetVersion = 'changed';
    const result = await target.send(f.input);
    expect(f.post.mock.calls[0]![0]).toBe('https://example.com/v1/chat/completions');
    expect(result.value.receipt.targetVersion).toBe('model-config-v1');
  });
  it.each(['stateful', 'isolation', 'http', 'invalid-limit', 'missing-limit'] as const)('rejects unsupported construction: %s', async field => {
    const f = await fixture();
    if (field === 'stateful') (f.scope.endpoint as { kind: string }).kind = 'assistant_threads';
    if (field === 'isolation') (f.scope.endpoint as { isolation: string }).isolation = 'unknown';
    if (field === 'http') f.scope.endpoint.url = 'http://localhost/';
    if (field === 'invalid-limit') f.deps.limits.maxCompletionTokens = Infinity;
    if (field === 'missing-limit') f.deps.limits.timeoutMs = undefined as unknown as number;
    expect(() => createRemediationTarget(f.deps)).toThrow('remediation_target_refused');
    expect(f.post).not.toHaveBeenCalled();
  });
  it.each(['current', 'changed-before-send', 'credential', 'callback'] as const)('rejects current secret policy failure: %s', async which => {
    const f = await fixture();
    if (which === 'current') f.currentSecrets.mockResolvedValue(['READY']);
    if (which === 'changed-before-send') f.currentSecrets.mockResolvedValueOnce([]).mockResolvedValue(['READY']);
    if (which === 'credential') { f.input.patch.patch = 'fixture-credential'; f.input.request.systemPrompt = f.input.patch.patch; f.input.patchDigest = remediationDigest(f.input.patch); }
    if (which === 'callback') f.currentSecrets.mockRejectedValue(new Error('fixture-credential'));
    await expect(createRemediationTarget(f.deps).send(f.input)).rejects.toThrow('remediation_target_unresolved');
    expect(f.post).not.toHaveBeenCalled();
  });
  it.each(['beforeDispatch', 'observed', 'transport', 'secret-response', 'timeout'] as const)('fails safely and never blindly repeats: %s', async which => {
    const f = await fixture();
    if (which === 'beforeDispatch') f.accounting.beforeDispatch.mockRejectedValue(new Error('fixture-credential'));
    if (which === 'observed') f.accounting.observed.mockRejectedValue(new Error('fixture-credential'));
    if (which === 'transport') f.post.mockRejectedValue(new Error('fixture-credential'));
    if (which === 'secret-response') f.post.mockResolvedValue({ ...completion, choices: [{ message: { role: 'assistant', content: 'fixture-credential' }, finish_reason: 'stop' }] });
    if (which === 'timeout') { f.deps.limits.timeoutMs = 5; f.post.mockImplementation(() => new Promise(() => {})); }
    const target = createRemediationTarget(f.deps);
    await expect(target.send(f.input)).rejects.toThrow('remediation_target_unresolved');
    await expect(target.send(f.input)).rejects.toThrow('remediation_target_unresolved');
    expect(f.post).toHaveBeenCalledTimes(which === 'beforeDispatch' ? 0 : 1);
    expect(f.accounting.ambiguous).toHaveBeenCalledTimes(1);
  });
  it('retains measured usage on definitive invalid completion without fabricating session costs', async () => {
    const f = await fixture(); f.post.mockResolvedValue({ ...completion, choices: [] });
    const result = await createRemediationTarget(f.deps).send(f.input);
    expect(result.value.response.ok).toBe(false); expect(result.costs).toEqual([]);
    expect(f.accounting.observed).toHaveBeenCalledWith(expect.anything(), { promptTokens: 10, completionTokens: 2, totalTokens: 12 });
    expect(f.accounting.ambiguous).not.toHaveBeenCalled();
  });
  it('records unknown usage as null and records late measured usage after timeout', async () => {
    const f = await fixture(); f.post.mockResolvedValue({ choices: completion.choices });
    await createRemediationTarget(f.deps).send(f.input);
    expect(f.accounting.observed).toHaveBeenCalledWith(expect.anything(), null);
    const late = await fixture(); late.deps.limits.timeoutMs = 5;
    let finish!: (v: unknown) => void;
    late.post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await expect(createRemediationTarget(late.deps).send(late.input)).rejects.toThrow();
    finish(completion);
    await vi.waitFor(() => expect(late.accounting.observed).toHaveBeenCalledWith(expect.anything(), { promptTokens: 10, completionTokens: 2, totalTokens: 12 }));
    expect(late.accounting.ambiguous).toHaveBeenCalledOnce();
  });
});

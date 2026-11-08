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
import { createRemediationTarget, type RemediationTargetScope, type RemediationTargetDeps } from '../targets/remediation';

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
  const accounting = { beforeDispatch: vi.fn(async () => {}), observed: vi.fn<RemediationTargetDeps['accounting']['observed']>(async () => {}), ambiguous: vi.fn(async () => {}) };
  const currentSecrets = vi.fn(async (): Promise<readonly string[]> => []);
  const deps: RemediationTargetDeps = { scope, currentSecrets, accounting, transport: { post }, limits: { timeoutMs: 1000, maxCompletionTokens: 128, maxRequestBytes: 256_000, maxResponseBytes: 100_000 } };
  return { scope, input, deps, post, accounting, currentSecrets };
}


describe('independent secured remediation target review', () => {
  it('ACCEPTANCE: detaches input before policy await; deeply freezes actual serialization and evidence', async () => {
    const f = await fixture();
    let release!: () => void;
    f.currentSecrets.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]); }));
    const original = structuredClone(f.input);
    const trial = createRemediationTarget(f.deps);
    const pending = trial.send(f.input);
    f.input.request.systemPrompt = 'caller mutation';
    f.input.patch.patch = 'caller mutation';
    f.deps.limits.maxCompletionTokens = 999;
    f.scope.original.suite.scenarios[0]!.objectiveChecks[0]!.description = 'weakened';
    f.deps.accounting.beforeDispatch = async () => { throw new Error('replaced callback'); };
    await Promise.resolve(); // bounded policy invocation starts in a microtask
    release();
    const result = await pending;
    const body = f.post.mock.calls[0]![1] as { messages: { content: string }[]; max_completion_tokens: number };
    expect(body.messages[0]!.content).toBe(original.patch.patch);
    expect(body.max_completion_tokens).toBe(128);
    expect(Object.isFrozen(body.messages)).toBe(true);
    expect(Object.isFrozen(body.messages[0])).toBe(true);
    expect(Reflect.set(body.messages[0]!, 'content', 'mutated by transport')).toBe(false);
    expect(result.value.receipt.actualSystemPrompt).toBe(body.messages[0]!.content);
    expect(Object.isFrozen(f.accounting.observed.mock.calls[0]![0])).toBe(true);
  });

  it('ACCEPTANCE: concurrent identical sends dispatch once within one adapter', async () => {
    const f = await fixture(), target = createRemediationTarget(f.deps);
    const results = await Promise.allSettled([target.send(f.input), target.send(f.input)]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(f.post).toHaveBeenCalledOnce();
  });

  it('ACCEPTANCE: default HTTPS transport rejects literal private address offline', async () => {
    const f = await fixture();
    delete f.deps.transport;
    f.scope.endpoint.url = 'https://127.0.0.1/v1/chat/completions';
    await expect(createRemediationTarget(f.deps).send(f.input)).rejects.toThrow('remediation_target_unresolved');
    expect(f.post).not.toHaveBeenCalled();
    expect(f.accounting.beforeDispatch).toHaveBeenCalledOnce();
    expect(f.accounting.observed).not.toHaveBeenCalled();
    expect(f.accounting.ambiguous).toHaveBeenCalledOnce();
  });

  it.each(['abc', 'abcd'])('REGRESSION R2: credential %s cannot reach payload or receipt content', async credential => {
    const f = await fixture();
    f.scope.endpoint.apiKey = credential;
    f.input.patch.patch = `Always include READY and ${credential}.`;
    f.input.request.systemPrompt = f.input.patch.patch;
    f.input.patchDigest = remediationDigest(f.input.patch);
    if (credential.length < 4) {
      expect(() => createRemediationTarget(f.deps)).toThrow();
      expect(f.post).not.toHaveBeenCalled();
    } else {
      const target = createRemediationTarget(f.deps);
      await expect(target.send(f.input)).rejects.toThrow('remediation_target_unresolved');
      expect(f.post).not.toHaveBeenCalled();
    }
  });

  it('REGRESSION R2: short configured credential is refused before any remote result', async () => {
    const f = await fixture(); f.scope.endpoint.apiKey = 'abc';
    f.post.mockResolvedValue({ ...completion, choices: [{ message: { role: 'assistant', content: 'READY abc' }, finish_reason: 'stop' }] });
    expect(() => createRemediationTarget(f.deps)).toThrow();
    expect(f.post).not.toHaveBeenCalled();
  });

  it('ACCEPTANCE: SQL reservation, payload evidence and usage survive fresh adapters and completed replay', async () => {
    const f = await fixture(), db = new PGlite();
    try {
      await db.exec(readFileSync(new URL('../evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
      await db.exec('CREATE TABLE review_reservation (operation_id text PRIMARY KEY, input_digest text NOT NULL, evidence jsonb, usage jsonb, ambiguous boolean NOT NULL DEFAULT false)');
      const sql: AgentTransactionalSql = { query: (s, p) => db.query(s, p), transaction: fn => db.transaction(tx => fn({ query: (s, p) => tx.query(s, p) })) };
      const authorize = vi.fn(async (a: Parameters<AuthorizedRemediation['authorize']>[0]) => {
        await db.query('INSERT INTO review_reservation (operation_id,input_digest) VALUES ($1,$2)', [a.operationId, a.inputDigest]);
        return true;
      });
      const accounting: RemediationTargetDeps['accounting'] = {
        async beforeDispatch(e) {
          const intent = await db.query<{ state: string }>('SELECT state FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2 AND input_digest=$3', [e.jobId, 'remediation_target', e.inputDigest]);
          expect(intent.rows).toEqual([{ state: 'pending' }]);
          const r = await db.query('UPDATE review_reservation SET evidence=$3 WHERE operation_id=$1 AND input_digest=$2 RETURNING operation_id', [e.operationId, e.inputDigest, JSON.stringify(e)]);
          expect(r.rows).toHaveLength(1);
        },
        async observed(e, u) { await db.query('UPDATE review_reservation SET usage=$2 WHERE operation_id=$1', [e.operationId, JSON.stringify(u)]); },
        async ambiguous(e) { await db.query('UPDATE review_reservation SET ambiguous=true WHERE operation_id=$1', [e.operationId]); },
      };
      const ctx: ServiceContext = { jobId: f.scope.job.jobId, environment: 'test', budgetMicroUsd: 1000, recordCost: vi.fn(async () => {}), recordProgress: async () => {} };
      const run = vi.fn(async () => ({ status: 'completed', output: patch }));
      const resolve = vi.fn(async (): Promise<AuthorizedRemediation> => ({ job: f.scope.job, finding: f.scope.finding, binding: f.scope.binding, original: f.scope.original, knownSecrets: [], trial: createRemediationTarget({ ...f.deps, accounting }), judge: null, authorize }));
      const call = () => createRemediationServices({ runner: { run } as unknown as AgentTaskRunner, checkpoints: new PostgresTextCheckpointStore(sql), resolve }).proposeAndVerifyFixDetailed(ctx, { findingId: f.scope.finding.id });
      const first = await call();
      expect(first.remediation.verification.status).toBe('verified');
      const rows = await db.query<{ evidence: { payloadDigest: string }; usage: unknown; ambiguous: boolean }>('SELECT evidence,usage,ambiguous FROM review_reservation ORDER BY operation_id');
      expect(rows.rows).toHaveLength(12);
      expect(rows.rows.every(r => r.usage !== null && !r.ambiguous)).toBe(true);
      expect(rows.rows.map(r => r.evidence.payloadDigest).sort()).toEqual(f.post.mock.calls.map(c => remediationDigest(c[1])).sort());
      expect(JSON.stringify(rows.rows)).not.toContain('fixture-credential');
      ctx.budgetMicroUsd = 0;
      expect(await call()).toEqual(first);
      expect(resolve).toHaveBeenCalledTimes(2); expect(run).toHaveBeenCalledOnce();
      expect(authorize).toHaveBeenCalledTimes(12); expect(f.post).toHaveBeenCalledTimes(12);
      // Current factory resolver policy, not a fresh transport send, protects stored replay.
      resolve.mockImplementation(async () => ({ job: f.scope.job, finding: f.scope.finding, binding: f.scope.binding, original: f.scope.original, knownSecrets: ['READY'], trial: createRemediationTarget({ ...f.deps, accounting }), judge: null, authorize }));
      await expect(call()).rejects.toThrow('Credential content refused');
      expect(f.post).toHaveBeenCalledTimes(12);
    } finally { await db.close(); }
  }, 30_000);

  it('ACCEPTANCE: lost usage acknowledgement holds SQL intent ambiguous across new adapter instances', async () => {
    const f = await fixture(), db = new PGlite();
    try {
      await db.exec(readFileSync(new URL('../evals/integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
      const sql: AgentTransactionalSql = { query: (s, p) => db.query(s, p), transaction: fn => db.transaction(tx => fn({ query: (s, p) => tx.query(s, p) })) };
      const usageRows: unknown[] = [];
      f.accounting.observed.mockImplementation(async (...args) => { usageRows.push(args); throw new Error('lost usage acknowledgement'); });
      f.accounting.ambiguous.mockRejectedValue(new Error('outbox unavailable'));
      const authorize = vi.fn(async () => true);
      const resolve = async (): Promise<AuthorizedRemediation> => ({ job: f.scope.job, finding: f.scope.finding, binding: f.scope.binding, original: f.scope.original, knownSecrets: [], trial: createRemediationTarget(f.deps), judge: null, authorize });
      const ctx: ServiceContext = { jobId: f.scope.job.jobId, environment: 'test', budgetMicroUsd: 1000, recordCost: async () => {}, recordProgress: async () => {} };
      const call = () => createRemediationServices({ runner: { run: async () => ({ status: 'completed', output: patch }) } as unknown as AgentTaskRunner, checkpoints: new PostgresTextCheckpointStore(sql), resolve }).proposeAndVerifyFixDetailed(ctx, { findingId: f.scope.finding.id });
      await expect(call()).rejects.toThrow('External operation unresolved');
      await expect(call()).rejects.toThrow('External operation unresolved');
      expect(f.post).toHaveBeenCalledOnce(); expect(authorize).toHaveBeenCalledOnce(); expect(usageRows).toHaveLength(1);
      expect((await db.query<{ state: string }>('SELECT state FROM text_integration.checkpoints WHERE kind=$1', ['remediation_target'])).rows).toEqual([{ state: 'ambiguous' }]);
    } finally { await db.close(); }
  }, 30_000);
});

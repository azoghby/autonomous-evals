import { isNaiveProxyJudgePendingError, isNaiveProxyJudgeReconciliationRequiredError } from '../../judges/naive-proxy';
import { createHash } from 'node:crypto';
import type { ServiceContext, RunResult } from '../../contracts/services';
import type { AgentTaskRunner } from '../../agents/session-service';
import { containsSecret } from '../../agents/redact';
import { TrackBBlockedError, TrackBPendingError, toContractCost } from '../service-adapter';
import type { Clock, CostEntry, JobRef, RubricJudge, TextTargetPort } from '../types';
import { assertRunMatches, assertValidRunId, canonicalJson, designTextSuite, evaluateObjectiveCheck, executeScenario, executionGaps, executionVerdict, investigateTextRun, SuiteRunSchema, verifyFrozenSuite } from '../text';
import type { FrozenTextSuite, ScenarioExecution, SuiteRun, TextDesignOutcome, TextInvestigation, TextExecutionDeps } from '../text';
import type { CheckpointKey, CheckpointValue, TextCheckpointStore } from './checkpoints';

export interface AuthorizedTextDependencies {
  /** Resolver MUST authorize ctx.jobId for the caller before returning these facts. */
  job: JobRef;
  target: TextTargetPort;
  /** Stable nonsecret identity of endpoint/model/configuration. Change when target changes. */
  targetVersion: string;
  judge: RubricJudge | null;
  knownSecrets?: readonly string[];
}
export interface TextEvaluationServiceDeps {
  runner: AgentTaskRunner;
  checkpoints: TextCheckpointStore;
  resolve(ctx: ServiceContext): Promise<AuthorizedTextDependencies>;
  /** Trusted authorized immutable admission port; never request/model supplied. */
  resolveApprovedSuite?(ctx: ServiceContext, suiteDigest: string): Promise<FrozenTextSuite | null>;
  clock?: Clock;
}
export interface TextSuiteDesignRequest {
  /** New owner-assigned design slots only; absent preserves historical replay. */
  factualGapPolicy?: 'propose_missing_reference.v1';
  suiteId: string;
  versionLabel: string;
  systemPrompt: string | null;
  referenceText: string | null;
}
export interface TextRunRequest { suiteDigest: string; runId: string; scenarioIds?: string[] }
export interface TextRunReference { suiteDigest: string; runId: string }

const digest = (input: unknown): string => createHash('sha256').update(canonicalJson(input)).digest('hex');
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const pending = (): never => { throw new TrackBPendingError(5_000, 'durable operation is pending; reconcile a lost worker before retrying'); };
const ambiguous = (): never => { throw new TrackBBlockedError('needs_operator', 'External execution is ambiguous; reconcile the existing operation before any redispatch.'); };
function value<T>(entry: CheckpointValue | null): T {
  if (!entry) throw new TrackBBlockedError('rejected_input', 'Required durable text artifact is missing.');
  if (entry.state === 'pending') return pending();
  if (entry.state === 'ambiguous') return ambiguous();
  return copy(entry.value) as T;
}

/** An explicit legacy projection: unknown, subjective and infrastructure states cannot be booleans. */
export function toLegacyRunResult(run: SuiteRun): RunResult {
  const parsed = SuiteRunSchema.parse(run);
  if (parsed.executions.length === 0 || parsed.executions.some(e => e.outcome !== 'completed' || executionGaps(e).length || e.checks.length === 0 || e.checks.some(c => c.kind !== 'objective' || !['pass', 'fail'].includes(c.status)))) {
    throw new TrackBBlockedError('needs_operator', 'Legacy RunResult cannot represent this rich text run; preserve its execution/check statuses.');
  }
  return { runId: parsed.runId, versionLabel: parsed.versionLabel, results: parsed.executions.map(e => ({ scenarioId: e.scenarioId, passed: executionVerdict(e) === 'pass', detail: e.checks.map(c => c.detail).join('\n') })) };
}

export function createTextEvaluationServices(deps: TextEvaluationServiceDeps) {
  const store = deps.checkpoints;
  const now = () => (deps.clock?.now() ?? new Date()).toISOString();
  async function authorized(ctx: ServiceContext) {
    const resolved = await deps.resolve(ctx);
    if (resolved.job.jobId !== ctx.jobId || resolved.job.environment !== ctx.environment || resolved.job.package !== 'text_eval' || !resolved.targetVersion?.trim()) {
      throw new TrackBBlockedError('rejected_input', 'Authorized text job/target identity mismatch.');
    }
    return resolved;
  }
  const key = (a: AuthorizedTextDependencies, kind: string, id: string, input: unknown): CheckpointKey => ({ jobId: a.job.jobId, kind, id, inputDigest: digest({ environment: a.job.environment, input }) });
  async function save(a: AuthorizedTextDependencies, kind: string, id: string, input: unknown, artifact: unknown) {
    const k = key(a, kind, id, input);
    const claim = await store.claim(k);
    if (claim.state === 'claimed') await store.complete(k, claim.token, artifact);
    else if (claim.state !== 'completed') value(claim);
    else if (canonicalJson(claim.value) !== canonicalJson(artifact)) throw new Error('text_artifact_identity_conflict');
  }
  async function costs(ctx: ServiceContext, a: AuthorizedTextDependencies, entries: CostEntry[]) {
    for (const cost of entries) {
      if (!cost.measured || !cost.externalId) throw new Error('text_cost_requires_measured_session_identity');
      await save(a, 'cost', cost.externalId, cost, cost);
      // Sink MUST enforce meta.idempotencyKey atomically; a write followed by lost acknowledgement is replayed.
      await ctx.recordCost(toContractCost(cost));
    }
  }
  function runner(ctx: ServiceContext, a: AuthorizedTextDependencies): AgentTaskRunner {
    return { async run(spec) {
      const result = await deps.runner.run(spec);
      if ('cost' in result && result.cost) {
        const c = result.cost;
        if (!c.measured || !c.externalId) throw new Error('text_cost_requires_measured_session_identity');
        await save(a, 'cost', c.externalId, c, c);
      }
      return result;
    } };
  }
  async function suiteFor(a: AuthorizedTextDependencies, suiteDigest: string, ctx: ServiceContext): Promise<FrozenTextSuite> {
    const admitted = await deps.resolveApprovedSuite?.(ctx, suiteDigest);
    const suite = verifyFrozenSuite(admitted ?? value(await store.get({ jobId: a.job.jobId, kind: 'suite', id: suiteDigest, inputDigest: key(a, 'suite', suiteDigest, suiteDigest).inputDigest })));
    if (suite.jobId !== a.job.jobId || suite.digest !== suiteDigest || containsSecret(JSON.stringify(suite), a.knownSecrets)) throw new Error('text_suite_identity_mismatch');
    return suite;
  }
  async function loadRun(a: AuthorizedTextDependencies, suite: FrozenTextSuite, runId: string): Promise<SuiteRun> {
    assertValidRunId(runId);
    const stored = value<{ run: SuiteRun; environment: string }>(await store.get({ jobId: a.job.jobId, kind: 'run_result', id: runId }));
    if (stored.environment !== a.job.environment) throw new Error('text_run_environment_mismatch');
    const run = SuiteRunSchema.parse(stored.run); assertRunMatches(suite, run); return run;
  }
  function executionDeps(a: AuthorizedTextDependencies, suite: FrozenTextSuite, scope: string) {
    let blocked: 'pending' | 'ambiguous' | null = null;
    let judgeRecoveryPending = false;
    const mark = (state: 'pending' | 'ambiguous') => { blocked = state === 'ambiguous' || blocked === 'ambiguous' ? 'ambiguous' : 'pending'; };
    const target: TextTargetPort = { async send(request) {
      if (blocked !== null) throw new Error('text_target_operation_blocked');
      const k = key(a, 'target', digest([request.runId, request.scenarioId]), { suiteDigest: suite.digest, targetVersion: a.targetVersion, scope, request });
      let claim: Awaited<ReturnType<TextCheckpointStore['claim']>>;
      try { claim = await store.claim(k); }
      catch { mark('ambiguous'); throw new Error('text_target_checkpoint_unknown'); }
      if (claim.state === 'completed') return copy(claim.value) as Awaited<ReturnType<TextTargetPort['send']>>;
      if (claim.state !== 'claimed') { mark(claim.state); throw new Error('text_target_checkpoint_blocked'); }
      try {
        const response = await a.target.send(request);
        if (!response || response.ok !== true || typeof response.text !== 'string' || !Number.isFinite(response.latencyMs) || response.latencyMs < 0) { await store.markAmbiguous(k, claim.token); mark('ambiguous'); throw new Error('text_target_response_unknown'); }
        if (containsSecret(response.text, a.knownSecrets)) {
          const refused = { ok: false as const, errorCode: 'credential_in_response', message: 'Credential content refused.', latencyMs: response.latencyMs };
          await store.complete(k, claim.token, refused); return refused;
        }
        await store.complete(k, claim.token, response); return response;
      } catch {
        mark('ambiguous');
        await store.markAmbiguous(k, claim.token).catch(() => undefined);
        throw new Error('text_target_execution_ambiguous');
      }
    } };
    const judge: RubricJudge | null = a.judge === null ? null : async input => {
      if (blocked !== null) throw new Error('text_judge_operation_blocked');
      const k = key(a, 'judge', input.operationId, { targetVersion: a.targetVersion, scope, input });
      const claim = await store.claim(k);
      if (claim.state === 'completed') {
        const result = claim.value as { unavailable: boolean; verdict?: Awaited<ReturnType<RubricJudge>> };
        if (result.unavailable || !result.verdict) throw new Error('text_judge_unavailable');
        return result.verdict;
      }
      if (claim.state !== 'claimed') { mark(claim.state); throw new Error('text_judge_unavailable'); }
      try {
        const verdict = await a.judge!(input);
        if (containsSecret(JSON.stringify(verdict), a.knownSecrets)) throw new Error('text_judge_credential');
        await store.complete(k, claim.token, { unavailable: false, verdict }); return verdict;
      } catch (error) {
        if (isNaiveProxyJudgePendingError(error) || isNaiveProxyJudgeReconciliationRequiredError(error)) {
          judgeRecoveryPending = true; mark(isNaiveProxyJudgePendingError(error) ? 'pending' : 'ambiguous');
          // This is the outer memoization claim. The provider's own SQL attempt/fence
          // remains untouched. An unknown state holds for reconciliation; no provider
          // dispatch is repeated merely because this outer memoization can resume.
          await store.release(k, claim.token);
          throw error;
        }
        await store.complete(k, claim.token, { unavailable: true }).catch(() => undefined);
        throw new Error('text_judge_unavailable');
      }
    };
    const execution: TextExecutionDeps = { target, judge, evaluateObjective: evaluateObjectiveCheck, knownSecrets: a.knownSecrets, clock: deps.clock };
    return { execution, canResumeJudgeRecovery: () => judgeRecoveryPending, assertUnblocked() { if (blocked === 'ambiguous') ambiguous(); if (blocked === 'pending') pending(); } };
  }

  async function designSuite(ctx: ServiceContext, input: TextSuiteDesignRequest): Promise<TextDesignOutcome> {
    const a = await authorized(ctx);
    if (!input.suiteId.trim()) throw new Error('text_suite_id_required');
    const k = key(a, 'design', input.suiteId, input);
    const claim = await store.claim(k);
    if (claim.state === 'completed') {
      const result = copy(claim.value) as TextDesignOutcome;
      await costs(ctx, a, result.costs);
      if (result.status === 'completed') await save(a, 'suite', result.suite.digest, result.suite.digest, result.suite);
      return result;
    }
    if (claim.state !== 'claimed') return value(claim);
    const result = await designTextSuite({ job: a.job, versionLabel: input.versionLabel, systemPrompt: input.systemPrompt, referenceText: input.referenceText, knownSecrets: a.knownSecrets, ...(input.factualGapPolicy ? { factualGapPolicy: input.factualGapPolicy } : {}) }, { runner: runner(ctx, a), budgetMicroUsd: ctx.budgetMicroUsd, now: () => deps.clock?.now() ?? new Date() });
    if (result.status === 'blocked' && result.agentOutcome?.status === 'pending') {
      // Safe because AgentSessionService resumes its persisted session, never a new task.
      await store.release(k, claim.token); await costs(ctx, a, result.costs); return result;
    }
    await store.complete(k, claim.token, result);
    if (result.status === 'completed') await save(a, 'suite', result.suite.digest, result.suite.digest, result.suite);
    await costs(ctx, a, result.costs); return result;
  }

  async function run(a: AuthorizedTextDependencies, ctx: ServiceContext, input: TextRunRequest, attempt: 'initial' | 'rerun', baselineRunId: string | null): Promise<SuiteRun> {
    assertValidRunId(input.runId);
    const suite = await suiteFor(a, input.suiteDigest, ctx);
    const ids = input.scenarioIds === undefined ? suite.scenarios.map(s => s.id) : [...new Set(input.scenarioIds)].sort();
    if (!ids.length || ids.some(id => !suite.scenarios.some(s => s.id === id))) throw new Error('text_invalid_scenario_selection');
    const identity = { suiteDigest: suite.digest, targetVersion: a.targetVersion, ids, attempt, baselineRunId };
    const identityKey = key(a, 'run_identity', input.runId, identity);
    const claim = await store.claim(identityKey);
    if (claim.state === 'claimed') await store.complete(identityKey, claim.token, { ...identity, startedAt: now() });
    else if (claim.state !== 'completed') value(claim);
    const existing = await store.get({ jobId: a.job.jobId, kind: 'run_result', id: input.runId });
    if (existing) return loadRun(a, suite, input.runId);
    const started = value<{ startedAt: string }>(await store.get(identityKey)).startedAt;
    const safe = executionDeps(a, suite, attempt);
    const executions: ScenarioExecution[] = [];
    for (const id of ids) {
      const k = key(a, 'scenario', digest([input.runId, id]), identity);
      const c = await store.claim(k);
      if (c.state === 'completed') { executions.push(copy(c.value) as ScenarioExecution); continue; }
      if (c.state !== 'claimed') value(c);
      if (c.state !== 'claimed') throw new Error('unreachable');
      const result = await executeScenario(suite, id, input.runId, attempt, safe.execution);
      try { safe.assertUnblocked(); }
      catch (error) { await store.release(k, c.token); throw error; }
      await store.complete(k, c.token, result); executions.push(result);
    }
    const result = SuiteRunSchema.parse({ schemaVersion: 'text_run.v1', jobId: suite.jobId, suiteDigest: suite.digest, versionLabel: suite.versionLabel, runId: input.runId, startedAt: started, completedAt: now(), executions });
    const resultKey = key(a, 'run_result', input.runId, identity);
    const finished = await store.claim(resultKey);
    if (finished.state === 'claimed') {
      await store.complete(resultKey, finished.token, { environment: a.job.environment, run: result });
      return result;
    }
    if (finished.state !== 'completed') return value(finished);
    return loadRun(a, suite, input.runId);
  }

  async function investigate(ctx: ServiceContext, input: TextRunReference): Promise<TextInvestigation> {
    const a = await authorized(ctx); const suite = await suiteFor(a, input.suiteDigest, ctx); const baseline = await loadRun(a, suite, input.runId);
    const identity = value<{ targetVersion: string }>(await store.get({ jobId: a.job.jobId, kind: 'run_identity', id: input.runId }));
    if (identity.targetVersion !== a.targetVersion) throw new TrackBBlockedError('rejected_input', 'Investigation must use the original run target version; use an explicit new rerun for a changed target.');
    const k = key(a, 'investigation', input.runId, { suiteDigest: suite.digest, run: baseline, targetVersion: a.targetVersion });
    const previousCosts = await store.get({ jobId: a.job.jobId, kind: 'investigation_costs', id: input.runId, inputDigest: k.inputDigest });
    if (previousCosts?.state === 'completed') await costs(ctx, a, previousCosts.value as CostEntry[]);
    const claim = await store.claim(k);
    if (claim.state === 'completed') { const result = copy(claim.value) as TextInvestigation; await costs(ctx, a, result.costs); return result; }
    if (claim.state !== 'claimed') return value(claim);
    const safe = executionDeps(a, suite, `reproduction:${input.runId}`);
    const durableRunner = runner(ctx, a);
    let result: TextInvestigation;
    try {
      result = await investigateTextRun({ job: a.job, suite, run: baseline, knownSecrets: a.knownSecrets }, {
        ...safe.execution, runner: { run: async spec => { safe.assertUnblocked(); return durableRunner.run(spec); } }, budgetMicroUsd: ctx.budgetMicroUsd,
      });
    } catch (error) {
      // Do not dispatch an investigator on partial reproduction evidence. Only the
      // independently fenced judge-pending path is safe to resume automatically.
      if (safe.canResumeJudgeRecovery()) await store.release(k, claim.token);
      else await store.markAmbiguous(k, claim.token);
      throw error;
    }
    const accountingKey = { ...k, kind: 'investigation_costs' };
    if (result.costs.length) {
      const accounting = await store.claim(accountingKey);
      if (accounting.state === 'claimed') await store.complete(accountingKey, accounting.token, result.costs);
      else if (accounting.state !== 'completed') value(accounting);
    }
    try { safe.assertUnblocked(); }
    catch (error) {
      if (safe.canResumeJudgeRecovery()) await store.release(k, claim.token);
      else await store.markAmbiguous(k, claim.token);
      await costs(ctx, a, result.costs); throw error;
    }
    if (result.investigatorStatus === 'pending') { await store.release(k, claim.token); await costs(ctx, a, result.costs); return result; }
    await store.complete(k, claim.token, result); await costs(ctx, a, result.costs); return result;
  }

  return {
    designSuite,
    async getSuite(ctx: ServiceContext, suiteDigest: string) { return suiteFor(await authorized(ctx), suiteDigest, ctx); },
    async runSuite(ctx: ServiceContext, input: TextRunRequest) { return run(await authorized(ctx), ctx, input, 'initial', null); },
    investigate,
    async rerun(ctx: ServiceContext, input: TextRunReference & { baselineRunId: string }) {
      const a = await authorized(ctx); const suite = await suiteFor(a, input.suiteDigest, ctx); const baseline = await loadRun(a, suite, input.baselineRunId);
      if (input.runId === input.baselineRunId) throw new Error('rerun_requires_new_run_id');
      return run(a, ctx, { suiteDigest: suite.digest, runId: input.runId, scenarioIds: baseline.executions.map(e => e.scenarioId) }, 'rerun', input.baselineRunId);
    },
    async reportInput(ctx: ServiceContext, input: TextRunReference) {
      const a = await authorized(ctx); const suite = await suiteFor(a, input.suiteDigest, ctx); const run = await loadRun(a, suite, input.runId);
      const investigation = value<TextInvestigation>(await store.get({ jobId: a.job.jobId, kind: 'investigation', id: input.runId, inputDigest: key(a, 'investigation', input.runId, { suiteDigest: suite.digest, run, targetVersion: a.targetVersion }).inputDigest }));
      await costs(ctx, a, investigation.costs);
      const limitations = [...investigation.limitations];
      for (const e of run.executions) if (e.outcome === 'infrastructure_error' || executionGaps(e).length) limitations.push(`${e.scenarioId}: ${e.outcome}; ${executionGaps(e).length} unresolved/not-assessed checks.`);
      return { suite, run, richFindings: investigation.findings, limitations, investigation };
    },
  };
}

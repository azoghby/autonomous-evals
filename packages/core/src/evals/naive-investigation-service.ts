/** Current authorized rich evidence, never public pass/fail booleans, drives investigation. */
import type { EvalServices, ServiceContext } from '../contracts/services';
import type { AgentTaskRunner } from '../agents/session-service';
import { containsSecret } from '../agents/redact';
import { createTextEvaluationServices, type AuthorizedTextDependencies } from './integration/services';
import type { TextCheckpointStore } from './integration/checkpoints';
import { canonicalJson } from './text/freeze';
import type { TextInvestigation } from './text/investigate';
import { FindingSchema, type Clock } from './types';
import { restoreFrozenTextSuite, restoreTextSuiteRun, type RetainedTextSuite, type RetainedTextRun, type TextContractScope } from './naive-contract-mapping';
import { TrackBBlockedError, TrackBPendingError, toContractFinding } from './service-adapter';
export interface AuthorizedNaiveInvestigation extends AuthorizedTextDependencies {
  scope: TextContractScope;
  retainedSuite: RetainedTextSuite;
  retainedRun: RetainedTextRun;
}
export interface NaiveInvestigationServiceDeps {
  runner: AgentTaskRunner;
  checkpoints: TextCheckpointStore;
  /** Resolve from authenticated durable job state; never select authority from request prose. */
  resolve(ctx: ServiceContext): Promise<AuthorizedNaiveInvestigation>;
  /** Atomically retain immutable full investigation under scope/run/target; reject conflicts.
   * Authorize again at commit, preserve costs/limitations/reproductions, never overwrite. */
  persistInvestigation(ctx: ServiceContext, artifact: { scope: TextContractScope; runId: string; targetVersion: string; investigation: TextInvestigation }): Promise<void>;
  clock?: Clock;
}
const reject = (): never => { throw new TrackBBlockedError('rejected_input', 'Investigation authority or retained evidence mismatch.'); };
/** Single-baseline text evaluation. Version comparison needs explicit finding identities and merge semantics. */
export function createNaiveInvestigationService(deps: NaiveInvestigationServiceDeps): Pick<EvalServices, 'investigate'> {
  return { async investigate(ctx, requestedSuite, requestedRuns) {
    ctx = { ...ctx };
    if (!Number.isSafeInteger(ctx.budgetMicroUsd) || ctx.budgetMicroUsd <= 0) throw new TrackBBlockedError('paused_budget', 'Investigation requires a positive authorized budget.');
    if (!Array.isArray(requestedRuns) || requestedRuns.length !== 1) return reject();
    const suite = structuredClone(requestedSuite), publicRun = structuredClone(requestedRuns[0]);
    function validate(a: AuthorizedNaiveInvestigation) {
      if (a.job.jobId !== ctx.jobId || a.job.environment !== ctx.environment || a.job.package !== 'text_eval' ||
        a.scope.jobId !== ctx.jobId || a.scope.environment !== ctx.environment || a.scope.customerId !== a.job.customerId || !a.targetVersion?.trim() ||
        a.knownSecrets !== undefined && (!Array.isArray(a.knownSecrets) || a.knownSecrets.some(s => typeof s !== 'string' || s.length < 4))) return reject();
      const secrets = [...(a.knownSecrets ?? [])];
      const frozen = restoreFrozenTextSuite(suite, a.retainedSuite, a.scope, secrets);
      const run = restoreTextSuiteRun(publicRun, a.retainedRun, { suite, retained: a.retainedSuite }, a.scope, secrets);
      return { frozen, run, secrets, identity: canonicalJson({ job: a.job, scope: a.scope, retainedSuite: a.retainedSuite, retainedRun: a.retainedRun, targetVersion: a.targetVersion }) };
    }
    const first = await deps.resolve(ctx), initial = validate(first);
    const scope = structuredClone(first.scope), runId = initial.run.runId, targetVersion = first.targetVersion;
    async function current() {
      const a = await deps.resolve(ctx), checked = validate(a);
      if (checked.identity !== initial.identity) return reject();
      return { a, ...checked };
    }
    async function checkpointEvidence() {
      const stored = await deps.checkpoints.get({ jobId: ctx.jobId, kind: 'run_result', id: runId });
      const identity = await deps.checkpoints.get({ jobId: ctx.jobId, kind: 'run_identity', id: runId });
      const authorized = await current();
      if (stored?.state !== 'completed' || identity?.state !== 'completed') return reject();
      const value = stored.value as { environment?: unknown; run?: unknown }, binding = identity.value as { targetVersion?: unknown };
      if (!value || !binding || value.environment !== ctx.environment || binding.targetVersion !== targetVersion || canonicalJson(value.run) !== canonicalJson(authorized.run)) return reject();
      return authorized;
    }
    await checkpointEvidence();
    const engine = createTextEvaluationServices({ checkpoints: deps.checkpoints, clock: deps.clock,
      runner: { run: async spec => { await checkpointEvidence(); return deps.runner.run(spec); } },
      resolve: async () => {
        const active = (await checkpointEvidence()).a;
        return { ...active, target: { send: async request => (await checkpointEvidence()).a.target.send(request) },
          judge: active.judge === null ? null : async input => { const judge = (await checkpointEvidence()).a.judge; if (!judge) return reject(); return judge(input); } };
      },
      resolveApprovedSuite: async (_ctx, digest) => { const a = await current(); if (digest !== a.frozen.digest) return reject(); return a.frozen; },
    });
    const investigation = structuredClone(await engine.investigate(ctx, { suiteDigest: scope.suiteDigest, runId }));
    let active = await checkpointEvidence();
    if (containsSecret(JSON.stringify(investigation), active.secrets)) return reject();
    if (investigation.investigatorStatus === 'pending') throw new TrackBPendingError(5_000, 'Investigator session pending.');
    if (['budget_exhausted', 'budget_paused'].includes(investigation.investigatorStatus)) throw new TrackBBlockedError('paused_budget', 'Investigator budget paused.');
    if (!['completed', 'skipped'].includes(investigation.investigatorStatus)) throw new TrackBBlockedError('needs_operator', 'Investigator did not produce a complete validated assessment.');
    await deps.persistInvestigation(ctx, { scope, runId, targetVersion, investigation: structuredClone(investigation) });
    active = await checkpointEvidence();
    if (containsSecret(JSON.stringify(investigation), active.secrets)) return reject();
    return investigation.findings.map(f => toContractFinding(FindingSchema.parse(f)));
  } };
}

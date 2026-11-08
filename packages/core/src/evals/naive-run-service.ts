/** Authorized rich text execution behind the legacy contract; no lite fallback. */
import type { EvalServices, ServiceContext } from "../contracts/services";
import type { AgentTaskRunner } from "../agents/session-service";
import { containsSecret } from "../agents/redact";
import type { Clock } from "./types";
import { createTextEvaluationServices, type AuthorizedTextDependencies } from "./integration/services";
import type { TextCheckpointStore } from "./integration/checkpoints";
import { canonicalJson } from "./text/freeze";
import { SuiteRunSchema } from "./text/schema";
import { assertRunMatches } from "./text/investigate";
import { assertValidRunId } from "./text/execute";
import { projectTextSuiteRun, restoreFrozenTextSuite, type RetainedTextRun, type RetainedTextSuite, type TextContractScope } from "./naive-contract-mapping";
import { TrackBBlockedError } from "./service-adapter";

type ContractTarget = Parameters<EvalServices["runSuite"]>[2];
export interface AuthorizedNaiveTextRun extends AuthorizedTextDependencies {
  /** Resolve from authenticated durable job/suite state, never the supplied Suite or target. */
  scope: TextContractScope;
  retained: RetainedTextSuite;
  canonicalTarget: ContractTarget;
  /** Stable durable run identity. Retries must return the same ID; changed targets need a new ID. */
  runId: string;
}
export interface NaiveRunServiceDeps {
  runner: AgentTaskRunner;
  checkpoints: TextCheckpointStore;
  resolve(ctx: ServiceContext): Promise<AuthorizedNaiveTextRun>;
  /** Persist immutable rich data, atomically keyed by scope + runId + targetVersion; reject conflicts.
   * Must authorize the current caller again at commit time. Never replace an existing artifact.
   */
  persistRun(ctx: ServiceContext, artifact: RetainedTextRun, identity: { runId: string; targetVersion: string }): Promise<void>;
  clock?: Clock;
}
const reject = (): never => { throw new TrackBBlockedError("rejected_input", "Text run authorization or immutable identity mismatch."); };
/** No public URL/key can select a transport; only the authorized resolver supplies it. */
export function createNaiveRunService(deps: NaiveRunServiceDeps): Pick<EvalServices, "runSuite"> {
  return { async runSuite(ctx, requestedSuite, requestedTarget, branchConnString) {
    ctx = { ...ctx };
    if (branchConnString !== undefined) reject(); // This adapter implements text execution only.
    if (!Number.isSafeInteger(ctx.budgetMicroUsd) || ctx.budgetMicroUsd <= 0) throw new TrackBBlockedError("paused_budget", "Text execution requires a positive authorized budget.");
    const suite = structuredClone(requestedSuite), target = structuredClone(requestedTarget);
    const first = await deps.resolve(ctx);
    function validate(a: AuthorizedNaiveTextRun) {
      if (a.knownSecrets !== undefined && (!Array.isArray(a.knownSecrets) || a.knownSecrets.some(s => typeof s !== "string" || s.length < 4))) reject();
      if (a.canonicalTarget.apiKey !== undefined && (typeof a.canonicalTarget.apiKey !== "string" || a.canonicalTarget.apiKey.length < 4)) reject();
      if (a.job.jobId !== ctx.jobId || a.job.environment !== ctx.environment || a.job.package !== "text_eval" ||
        a.scope.jobId !== ctx.jobId || a.scope.environment !== ctx.environment || a.scope.customerId !== a.job.customerId ||
        !a.targetVersion?.trim() || canonicalJson(target) !== canonicalJson(a.canonicalTarget)) reject();
      try { assertValidRunId(a.runId); } catch { reject(); }
      const secrets = [...(a.knownSecrets ?? []), ...(a.canonicalTarget.apiKey ? [a.canonicalTarget.apiKey] : [])];
      const frozen = restoreFrozenTextSuite(suite, a.retained, a.scope, secrets);
      return { frozen, secrets, identity: canonicalJson({ scope: a.scope, retained: a.retained, targetVersion: a.targetVersion, runId: a.runId, target: a.canonicalTarget }) };
    }
    const original = validate(first);
    const scope = structuredClone(first.scope), retained = structuredClone(first.retained);
    const runId = first.runId, targetVersion = first.targetVersion;
    async function current() {
      const a = await deps.resolve(ctx), checked = validate(a);
      if (checked.identity !== original.identity) reject();
      return { a, ...checked };
    }
    const rich = createTextEvaluationServices({ runner: deps.runner, checkpoints: deps.checkpoints, clock: deps.clock,
      resolve: async () => {
        const authorized = await current(), active = authorized.a;
        return { ...active, knownSecrets: authorized.secrets, target: { send: async request => (await current()).a.target.send(request) },
          judge: active.judge === null ? null : async input => {
            const judge = (await current()).a.judge;
            if (!judge) reject();
            return judge!(input);
          } };
      },
      resolveApprovedSuite: async (_ctx, digest) => {
        const authorized = await current();
        if (digest !== authorized.frozen.digest) reject();
        return authorized.frozen;
      },
    });
    const run = SuiteRunSchema.parse(await rich.runSuite(ctx, { suiteDigest: original.frozen.digest, runId }));
    const authorized = await current();
    try { assertRunMatches(authorized.frozen, run); } catch { reject(); }
    if (run.runId !== runId || run.executions.length !== authorized.frozen.scenarios.length || containsSecret(JSON.stringify(run), authorized.secrets)) reject();
    // Retain even valid rubric/inconclusive states before the legacy mapper refuses them.
    const artifact: RetainedTextRun = { schemaVersion: "naive_contract_run.v1", scope, run: structuredClone(run) };
    await deps.persistRun(ctx, structuredClone(artifact), { runId, targetVersion });
    const publication = await current();
    return projectTextSuiteRun(run, { suite, retained }, publication.a.scope, publication.secrets).result;
  } };
}

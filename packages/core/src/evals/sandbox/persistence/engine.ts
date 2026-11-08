import { AgentSessionService } from '../../../agents/session-service';
import { PostgresTextCheckpointStore } from '../../integration/checkpoints';
import { executionDigest } from '../execution/runner';
import { createPostgresSandboxGenerationContinuation } from '../generation/continuation';
import { createSandboxEngine, type PrivateSandboxReport, type SandboxEngineConfig, type SandboxEngineAuthority } from '../integration';
import { createPostgresSandboxPersistence, type PostgresSandboxPersistenceConfig } from './index';
import { validatePrivateReport } from './schema';

export type DurableSandboxEngineConfig = Omit<SandboxEngineConfig, 'authority' | 'generationConstructor'> & {
  /** Only new operations; stable service directory/pins/namespace/budget-period contract. */
  generationContinuation?: { executionIdentity: string };
  authority: Omit<SandboxEngineAuthority, 'replay' | 'persistPrivateReport'>;
};

/** Explicit wire projection for the engine's one optional own-undefined field.
 * No general JSON stringify/parse bypass: all other non-JSON evidence is rejected
 * by the raw store. The engine's receipt oracle emits `injection: undefined`
 * when there was no injection. Its JSON representation is an absent key. */
function wireReport<T>(value: T): T {
  const report = value as PrivateSandboxReport | null;
  if (report?.schema !== 'sandbox-private-report-v1' || report.media?.kind !== 'receipt') return value;
  const copy = structuredClone(report);
  if (copy.media?.kind === 'receipt' && copy.media.artifact.oracle.injection === undefined)
    delete copy.media.artifact.oracle.injection;
  return copy as T;
}

/** Trusted server construction only. Scoped SQL replaces engine and gate replay,
 * generation fencing and private report writes. Execution/runtime, media dispatch,
 * snapshots, approval and current principal policy remain explicit trusted ports.
 * Do not return this private engine/report API directly to customers. */
export function createDurableSandboxEngine(config: DurableSandboxEngineConfig, persistenceConfig: PostgresSandboxPersistenceConfig) {
  const scope = { ...persistenceConfig.scope };
  if (config.scope.jobId !== scope.jobId || config.scope.environmentId !== scope.environmentId
    || config.generation.job.jobId !== scope.jobId || config.generation.job.customerId !== scope.tenantId)
    throw Error('sandbox_persistence_engine_scope_conflict');
  // Snapshot server construction. Current policy still runs through these pinned callbacks.
  const db = persistenceConfig.db;
  const persistenceAuthorize = persistenceConfig.authorize;
  const engineAuthorize = config.authority.authorize;
  const secretSources = [config.generation.knownSecrets, persistenceConfig.knownSecrets];
  const retainedSecrets = new Set<string>();
  const knownSecrets = () => {
    for (const source of secretSources) {
      const values = typeof source === 'function' ? source() : source ?? [];
      if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || !value.length))
        throw new Error('invalid_sandbox_continuation_secrets');
      values.forEach(value => retainedSecrets.add(value));
    }
    return [...retainedSecrets];
  };
  const generation = { ...config.generation, job: structuredClone(config.generation.job), knownSecrets };
  const continuation = config.generationContinuation ? { ...config.generationContinuation } : undefined;
  const gateVersions = structuredClone(config.gateVersions), gateEvalVersions = structuredClone(config.gateEvalVersions);
  const persistence = createPostgresSandboxPersistence({ ...persistenceConfig, scope });
  const service = generation.runner;
  if (continuation && (!(service instanceof AgentSessionService) || !continuation.executionIdentity?.trim()))
    throw new Error('sandbox_generation_continuation_service_required');
  const authorizeGeneration = async () =>
    await persistenceAuthorize({ scope: { ...scope }, operation: 'generation_bind' }) === true
    && await engineAuthorize({ scope: { jobId: scope.jobId, environmentId: scope.environmentId }, operation: 'generate', suiteDigest: null }) === true;
  const executionIdentity = continuation ? executionDigest({ contract: continuation.executionIdentity, gateVersions, gateEvalVersions }) : '';
  const generationConstructor: SandboxEngineConfig['generationConstructor'] = continuation ? adapterConfig => {
    const generate = createPostgresSandboxGenerationContinuation({ ...adapterConfig, db, scope,
      service: service as AgentSessionService, executionIdentity, authorize: authorizeGeneration });
    return async request => {
      try {
        if (!await authorizeGeneration()) throw new Error('unauthorized');
        // Reuse the EXACT old binder primary key as atomic admission. Old claims
        // of any state/digest are never migrated. A completed marker also prevents
        // a later legacy worker from obtaining permission to dispatch.
        const key = { jobId: `sandbox-persistence-v1:${executionDigest(scope)}`,
          kind: 'sandbox_generation_binding_v1', id: executionDigest(`${scope.jobId}:${request.operationKey}`),
          inputDigest: executionDigest({ namespace: 'sandbox-generation-admission-v1', request, executionIdentity }) };
        const marker = { schema: 'sandbox-generation-admission-v1', executionIdentity, requestDigest: executionDigest(request) };
        await db.transaction(async tx => {
          const atomic = new PostgresTextCheckpointStore({ query: (sql, params) => tx.query(sql, params), transaction: fn => fn(tx) });
          const claim = await atomic.claim(key);
          if (!await authorizeGeneration()) throw new Error('unauthorized');
          if (claim.state === 'claimed') await atomic.complete(key, claim.token, marker);
          else if (claim.state !== 'completed' || executionDigest(claim.value) !== executionDigest(marker))
            throw new Error('sandbox_generation_legacy_or_unknown_claim');
          if (!await authorizeGeneration()) throw new Error('unauthorized');
        });
        return await generate(request);
      } catch {
        return { status: 'blocked' as const, reason: 'continuation_unresolved', candidates: [], dropped: [], costs: [] };
      }
    };
  } : undefined;
  const replay = {
    once: <T>(key: string, digest: string, operation: () => Promise<T>): Promise<T> =>
      persistence.replay.once(key, digest, async () => {
        const value = wireReport(await operation());
        if ((value as PrivateSandboxReport | null)?.schema === 'sandbox-private-report-v1')
          validatePrivateReport(value, scope.jobId);
        return value;
      }).then(value => {
        if ((value as PrivateSandboxReport | null)?.schema === 'sandbox-private-report-v1')
          validatePrivateReport(value, scope.jobId);
        return value;
      }),
  };
  const engine = createSandboxEngine({ ...config, generationConstructor, generation: { ...generation, bindOperation: persistence.bindOperation },
    gates: { ...config.gates, replay }, authority: { ...config.authority, replay,
      persistPrivateReport: persistence.persistPrivateReport } });
  return { ...engine, readPrivateReport: persistence.readPrivateReport };
}

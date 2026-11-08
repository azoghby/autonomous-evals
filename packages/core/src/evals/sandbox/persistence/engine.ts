import { createSandboxEngine, type PrivateSandboxReport, type SandboxEngineConfig, type SandboxEngineAuthority } from '../integration';
import { createPostgresSandboxPersistence, type PostgresSandboxPersistenceConfig } from './index';
import { validatePrivateReport } from './schema';

export type DurableSandboxEngineConfig = Omit<SandboxEngineConfig, 'authority'> & {
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
  const persistence = createPostgresSandboxPersistence(persistenceConfig);
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
  const engine = createSandboxEngine({ ...config, generation: { ...config.generation, bindOperation: persistence.bindOperation },
    gates: { ...config.gates, replay }, authority: { ...config.authority, replay,
      persistPrivateReport: persistence.persistPrivateReport } });
  return { ...engine, readPrivateReport: persistence.readPrivateReport };
}

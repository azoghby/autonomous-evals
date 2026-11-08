import type { SandboxRun } from '../../../sandbox/spec.js';
import { hashGradingScenario } from '../grading/index.js';
import { capturePGliteImage, retainRuntimeRun, runtimeBridgeDigest, type RuntimeBinding, type PolicyRequest, type SnapshotArtifact, type SqlImageSource, type ExactRowPolicy } from '../runtime-bridge/index.js';
import { createDurableRuntimeSnapshots, type DurableRuntimeSnapshotsConfig, type SnapshotReceipts } from '../runtime-storage/recovery.js';
import { storageJson } from '../runtime-storage/store.js';

/** Server-only composition. Allocation, independent policy issuance and the engine's
 * permanent execution fence remain caller responsibilities. Never expose raw runs. */
export function createDurableRuntimeComposition(config: DurableRuntimeSnapshotsConfig) {
  const pinned = { ...config };
  const snapshots = createDurableRuntimeSnapshots(pinned);
  const live = new Map<string, { binding: PolicyRequest; seal(): Promise<void> }>();
  const requestFor = (runId: string, binding: RuntimeBinding): PolicyRequest => ({
    runId, worldId: binding.worldId, executionIdentity: binding.executionIdentity,
    scenarioHash: hashGradingScenario(binding.scenario), envHash: binding.versions.envHash,
    suiteHash: binding.versions.suiteHash, versions: structuredClone(binding.versions),
  });
  return {
    /** Allocate privately, call immediately before any operations. On failure the
     * allocating owner must dispose the raw run; this method never retries it. */
    async retain(options: { run: SandboxRun; binding: RuntimeBinding; source: SqlImageSource }) {
      const binding = structuredClone(options.binding), raw = options.run, source = options.source;
      const request = requestFor(raw.runId, binding);
      if (live.has(raw.runId)) throw new Error('runtime_composition_run_conflict');
      // Reserve before asynchronous preparation; even failed allocation is not reused.
      live.set(raw.runId, { binding: request, seal: async () => { throw new Error('runtime_composition_not_ready'); } });
      let policy: ExactRowPolicy | null = null;
      const preparation = createDurableRuntimeSnapshots({ ...pinned, resolvePolicy: async b => {
        const resolved = await pinned.resolvePolicy(b);
        policy = structuredClone(resolved);
        return resolved;
      } });
      const prepared = await preparation.prepare(request);
      const issuedPolicy = structuredClone(policy);
      const receipts: Partial<SnapshotReceipts> = {};
      const observed: SandboxRun = { runId: raw.runId,
        callTool: (name, args) => raw.callTool(name, args),
        query: (sql, params) => raw.query(sql, params),
        dispose: () => raw.dispose(),
        ...(raw.exec ? { exec: (sql: string) => raw.exec!(sql) } : {}),
        diff: async () => { const value = await raw.diff(); receipts.diff = structuredClone(value); return value; },
        trajectory: () => { const value = raw.trajectory(); receipts.toolCalls = structuredClone(value); return value; },
        outbox: async () => { const value = await raw.outbox(); receipts.outbox = structuredClone(value); return value; },
      };
      const bridge = await retainRuntimeRun({ run: observed, binding, issuePolicy: async () => structuredClone(issuedPolicy), capture: async () => {
        if (!receipts.diff || !receipts.toolCalls || !receipts.outbox) throw new Error('runtime_composition_receipts_missing');
        const record = await prepared.publish(source, receipts as SnapshotReceipts);
        const saved = await pinned.storage.get(request);
        if (!saved || runtimeBridgeDigest(saved.record) !== runtimeBridgeDigest(record)) throw new Error('runtime_composition_publication_conflict');
        const image = await capturePGliteImage({ dumpDataDir: async () => new Blob([Uint8Array.from(saved.bytes).buffer]) }, pinned.maxRows);
        if (image.digest !== record.imageDigest) throw new Error('runtime_composition_image_conflict');
        return image;
      } });
      live.set(raw.runId, { binding: request, seal: bridge.seal });
      return { run: bridge.run, seal: bridge.seal,
        async gateSnapshot() { await bridge.seal(); const snapshot = await snapshots.recover(request); if (!snapshot) throw new Error('runtime_composition_snapshot_missing'); return snapshot; },
        // Forgetting only removes the process-local image; durable retention is explicit.
        async forget() {
          await bridge.forget();
          live.set(request.runId, { binding: request, seal: async () => {} });
        },
      };
    },
    /** Structurally implements engine authority.finalSnapshot. A restart needs no
     * registry reconstruction or runtime allocation: exact receipts bind SQL lookup. */
    async finalSnapshot(rawArtifact: SnapshotArtifact) {
      const artifact = JSON.parse(storageJson(rawArtifact)) as SnapshotArtifact;
      if (!artifact.runId || !artifact.worldId) throw new Error('runtime_composition_identity_missing');
      const binding: RuntimeBinding = { ...artifact.input, worldId: artifact.worldId, executionIdentity: artifact.identityDigest };
      if (runtimeBridgeDigest(binding.environment) !== binding.versions.envHash) throw new Error('runtime_composition_environment_conflict');
      const request = requestFor(artifact.runId, binding), current = live.get(artifact.runId);
      if (current) {
        if (runtimeBridgeDigest(current.binding) !== runtimeBridgeDigest(request)) throw new Error('runtime_composition_identity_conflict');
        await current.seal();
      }
      const saved = await pinned.storage.get(request);
      if (!saved) throw new Error('runtime_composition_snapshot_missing');
      if (runtimeBridgeDigest({ diff: artifact.diff, toolCalls: artifact.toolCalls, outbox: artifact.outbox }) !==
          runtimeBridgeDigest({ diff: saved.record.diff, toolCalls: saved.record.toolCalls, outbox: saved.record.outbox })) throw new Error('runtime_composition_receipts_conflict');
      const snapshot = await snapshots.recover(request);
      if (!snapshot) throw new Error('runtime_composition_snapshot_missing');
      return snapshot;
    },
  };
}

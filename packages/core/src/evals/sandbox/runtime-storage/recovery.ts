import { capturePGliteImage, runtimeBridgeDigest, type PolicyRequest, type ExactRowPolicy, type RuntimeSnapshot, type SqlImageSource } from '../runtime-bridge/index.js';
import { ROW_DIFF_SQL, type RowAuthority } from '../grading/index.js';
import type { StateDiff, ToolCallRecord } from '../../../sandbox/spec.js';
import { validateBinding, storageJson, type RuntimeStorage, type StoredSnapshot } from './store.js';

export interface SnapshotReceipts { diff: StateDiff[]; toolCalls: ToolCallRecord[]; outbox: Record<string, unknown>[] }
export interface DurableRuntimeSnapshotsConfig {
  storage: RuntimeStorage;
  /** Trusted durable lookup ONLY: policy must have been issued independently before
   * execution. Never create grants here from observed diff, samples or model input. */
  resolvePolicy(binding: PolicyRequest): Promise<ExactRowPolicy | null>;
  /** Needed only for the legacy synchronous trajectory() contract. Must check
   * current ownership AND current/retired secrets synchronously; absence denies. */
  synchronousReadGuard?(receipt: ToolCallRecord[]): boolean;
  maxRows?: number;
  maxImageBytes?: number;
}

/** Retains full data-directory bytes; never reconstructs tables from receipts. */
export function createDurableRuntimeSnapshots(config: DurableRuntimeSnapshotsConfig) {
  const storage = config.storage;
  const maxRows = config.maxRows ?? 5000;
  const maxBytes = config.maxImageBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024)
    throw new Error('runtime_storage_bound_invalid');
  const lookup = async (binding: PolicyRequest): Promise<ExactRowPolicy | null> => {
    const policy = structuredClone(await config.resolvePolicy(structuredClone(binding)));
    if (policy) {
      const { policyId, allowed: _, ...request } = policy;
      if (!policyId?.trim() || runtimeBridgeDigest(request) !== runtimeBridgeDigest(binding)) throw new Error('runtime_storage_policy_conflict');
    }
    return policy;
  };
  const samePolicy = async (binding: PolicyRequest, expected: ExactRowPolicy | null) => {
    if (runtimeBridgeDigest(await lookup(binding)) !== runtimeBridgeDigest(expected)) throw new Error('runtime_storage_policy_conflict');
  };
  return {
    /** Call before tools execute. The durable resolver owns issuance ordering. */
    async prepare(rawBinding: PolicyRequest) {
      const binding = validateBinding(rawBinding);
      await storage.authorize('write');
      const policy = await lookup(binding);
      await storage.authorize('write');
      let publication: Promise<StoredSnapshot> | undefined;
      return {
        /** One capture per prepared handle; unknown SQL commit acknowledgements are
         * reconciled by reading this exact binding, never by recapturing a live run. */
        publish(source: SqlImageSource, rawReceipts: SnapshotReceipts): Promise<StoredSnapshot> {
          if (publication) return publication.then(record => structuredClone(record));
          const receipts = JSON.parse(storageJson(rawReceipts)) as SnapshotReceipts;
          if (Object.keys(receipts).sort().join(',') !== 'diff,outbox,toolCalls') throw new Error('runtime_storage_receipts_invalid');
          publication = (async () => {
            await storage.authorize('write');
            await samePolicy(binding, policy);
            await storage.authorize('write');
            const blob = await source.dumpDataDir();
            if (blob.size < 1 || blob.size > maxBytes) throw new Error('runtime_storage_image_bound');
            const bytes = new Uint8Array(await blob.arrayBuffer());
            await storage.authorize('write');
            const { createHash } = await import('node:crypto');
            const imageDigest = createHash('sha256').update(bytes).digest('hex');
            const record: StoredSnapshot = { binding, policy, diff: receipts.diff, toolCalls: receipts.toolCalls, outbox: receipts.outbox, imageDigest, imageSize: bytes.length,
              snapshotId: runtimeBridgeDigest({request: binding, image: imageDigest, diff: receipts.diff, calls: receipts.toolCalls, outbox: receipts.outbox}) };
            await storage.put(record, bytes);
            await storage.authorize('write');
            storage.screenMetadata(record);
            return record;
          })();
          return publication.then(record => structuredClone(record));
        },
      };
    },
    async recover(rawBinding: PolicyRequest): Promise<RuntimeSnapshot | null> {
      const binding = validateBinding(rawBinding);
      await storage.authorize('read');
      const saved = await storage.get(binding);
      if (!saved) return null;
      const { record, bytes } = saved;
      if (bytes.length > maxBytes) throw new Error('runtime_storage_image_bound');
      await samePolicy(binding, record.policy);
      await storage.screenImage(bytes);
      await storage.authorize('read');
      // capturePGliteImage copies the persisted exact bytes and restores a separate DB.
      const image = await capturePGliteImage({ dumpDataDir: async () => new Blob([Uint8Array.from(bytes).buffer]) }, maxRows);
      if (image.digest !== record.imageDigest) throw new Error('runtime_storage_image_conflict');
      const db = await image.open();
      let released = false;
      const query = async (sql: string, params?: unknown[]) => {
        if (released) throw new Error('snapshot_released');
        await storage.authorize('read');
        const result = await db.query(sql, params);
        storage.screenMetadata(result);
        await storage.authorize('read');
        storage.screenMetadata(result);
        if (released) throw new Error('snapshot_released');
        return result;
      };
      try {
        const rows = await query(ROW_DIFF_SQL);
        const counts = new Map<string, {inserted:number;updated:number;deleted:number}>();
        for (const row of rows) {
          if (typeof row.table_name !== 'string' || !['inserted','updated','deleted'].includes(String(row.change))) throw new Error('runtime_storage_relation_invalid');
          const count = counts.get(row.table_name) ?? {inserted:0,updated:0,deleted:0};
          count[row.change as 'inserted']++; counts.set(row.table_name,count);
        }
        if (new Set(record.diff.map(d => d.table)).size !== record.diff.length || counts.size !== record.diff.length || record.diff.some(d => {
          const c = counts.get(d.table); return !c || c.inserted !== d.inserted || c.updated !== d.updated || c.deleted !== d.deleted;
        })) throw new Error('runtime_storage_relation_incomplete');
        const authority: RowAuthority | undefined = record.policy ? { runId:binding.runId,snapshotId:record.snapshotId,scenarioHash:binding.scenarioHash,
          envHash:binding.envHash,suiteHash:binding.suiteHash,allowed:structuredClone(record.policy.allowed) } : undefined;
        storage.screenMetadata(record);
        await storage.authorize('read');
        storage.screenMetadata(record);
        return {
          run: {runId:binding.runId,query,
            diff:async()=>{ await storage.authorize('read'); if(released)throw new Error('snapshot_released'); storage.screenMetadata(record.diff); await storage.authorize('read'); storage.screenMetadata(record.diff); if(released)throw new Error('snapshot_released'); return structuredClone(record.diff); },
            trajectory:()=>{
              if(released)throw new Error('snapshot_released');
              const calls = structuredClone(record.toolCalls);
              if(config.synchronousReadGuard?.(structuredClone(calls)) !== true) throw new Error('runtime_storage_sync_read_denied');
              storage.screenMetadata(calls);
              return calls;
            }},
          evidence: {completeDiff:{runId:binding.runId,allTables:true,snapshotId:record.snapshotId},
            rowDiff:{runId:binding.runId,snapshotId:record.snapshotId,allRows:true,relation:'sandbox_diff'},...(authority?{rowAuthority:authority}:{})},
          async release(){if(!released){released=true;await db.close();}},
        };
      } catch(error) { await db.close(); throw error; }
    },
  };
}

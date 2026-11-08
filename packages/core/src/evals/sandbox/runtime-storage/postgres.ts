import type { AgentTransactionalSql } from '../../../agents/postgres-ports.js';
import { containsSecret } from '../../../agents/redact.js';
import { runtimeBridgeDigest } from '../runtime-bridge/index.js';
import { imageDigest, storageIdentity, storageInvalid, storageJson, validateBinding, validateStoredSnapshot,
  type RuntimeStorage, type SnapshotBinding, type SnapshotScope, type StoredSnapshot } from './store.js';

export type RuntimeStorageOperation = 'read' | 'write' | 'retain' | 'release' | 'reap';
export interface PostgresRuntimeStorageConfig {
  db: AgentTransactionalSql;
  scope: SnapshotScope;
  authorize(input: { scope: SnapshotScope; operation: RuntimeStorageOperation }): Promise<boolean>;
  /** Current AND retired credentials for the complete retention period, resolved afresh. */
  knownSecrets(): readonly string[];
  /** Required trusted policy for a complete binary image, not a UTF-8 scan of compressed bytes.
   * Must reject an unsafe image. Never pass through a model/customer callback. */
  screenImage(bytes: Uint8Array, secrets: readonly string[]): Promise<void>;
  maxImageBytes?: number;
  maxMetadataBytes?: number;
}
interface Row { binding_digest: string; metadata: StoredSnapshot; metadata_digest: string; image_digest: string; image_size: string | number; image: Uint8Array | null }

/** Fixed SQL, private server credential, pinned READ COMMITTED transactions without callback retries.
 * Publication is one atomic row. A null image is a permanent reaped tombstone, never a reusable run. */
export function createPostgresRuntimeStorage(config: PostgresRuntimeStorageConfig): RuntimeStorage {
  const scope = JSON.parse(storageJson(config.scope)) as SnapshotScope;
  if (Object.keys(scope).sort().join(',') !== 'environmentId,jobId,tenantId') storageInvalid();
  Object.values(scope).forEach(storageIdentity);
  const key = runtimeBridgeDigest(scope), maxImage = config.maxImageBytes ?? 64 * 1024 * 1024, maxMetadata = config.maxMetadataBytes ?? 4_000_000;
  if (!Number.isSafeInteger(maxImage) || maxImage < 1 || maxImage > 268435456 || !Number.isSafeInteger(maxMetadata) || maxMetadata < 1 || maxMetadata > 16_000_000
    || typeof config.authorize !== 'function' || typeof config.knownSecrets !== 'function' || typeof config.screenImage !== 'function') storageInvalid();
  const authorize = config.authorize, getSecrets = config.knownSecrets, imagePolicy = config.screenImage;
  const retired = new Set<string>();
  const secrets = (): readonly string[] => {
    const values = getSecrets();
    if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !v.length)) throw new Error('runtime_storage_invalid_secrets');
    values.forEach(v => retired.add(v));
    return [...retired];
  };
  const auth = async (operation: RuntimeStorageOperation) => {
    secrets();
    if (await authorize({ scope: { ...scope }, operation }) !== true) throw new Error('runtime_storage_unauthorized');
    secrets();
  };
  const screenMetadata = (value: unknown): void => {
    const text = storageJson(value, maxMetadata), current = secrets();
    if (containsSecret(text, current) || current.some(s => text.includes(s) || text.includes(JSON.stringify(s).slice(1, -1)))) throw new Error('runtime_storage_secret_detected');
  };
  const screenImage = async (bytes: Uint8Array): Promise<void> => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxImage) storageInvalid();
    const current = secrets();
    await imagePolicy(Uint8Array.from(bytes), current);
    // A decision on the old registry cannot authorize a newly rotated credential.
    if (runtimeBridgeDigest(secrets()) !== runtimeBridgeDigest(current)) throw new Error('runtime_storage_secret_policy_changed');
  };
  const finishImage = async (operation: RuntimeStorageOperation, bytes: Uint8Array): Promise<void> => {
    await screenImage(bytes);
    const reviewed = runtimeBridgeDigest(secrets());
    await auth(operation);
    if (reviewed !== runtimeBridgeDigest(secrets())) throw new Error('runtime_storage_secret_policy_changed');
  };
  const checked = (row: Row, binding: SnapshotBinding): { record: StoredSnapshot; bytes: Uint8Array } => {
    if (row.binding_digest !== runtimeBridgeDigest(binding)) throw new Error('runtime_storage_identity_conflict');
    const record = validateStoredSnapshot(row.metadata, maxMetadata);
    screenMetadata(record);
    if (runtimeBridgeDigest(record.binding) !== row.binding_digest || runtimeBridgeDigest(record) !== row.metadata_digest
      || record.imageDigest !== row.image_digest || record.imageSize !== Number(row.image_size)) throw new Error('runtime_storage_integrity_conflict');
    if (row.image === null) throw new Error('runtime_storage_reaped');
    if (!(row.image instanceof Uint8Array) || row.image.byteLength > maxImage || row.image.byteLength !== record.imageSize || imageDigest(row.image) !== record.imageDigest)
      throw new Error('runtime_storage_integrity_conflict');
    return { record, bytes: Uint8Array.from(row.image) };
  };
  const select = `SELECT binding_digest,
    CASE WHEN octet_length(metadata::text) <= $4 THEN metadata ELSE NULL END AS metadata,
    metadata_digest, image_digest, image_size,
    CASE WHEN image_size <= $3 AND octet_length(image) <= $3 THEN image ELSE NULL END AS image
    FROM sandbox_runtime_storage.images WHERE scope_key=$1 AND run_id=$2`;
  const lookup = (binding: SnapshotBinding) => [key,binding.runId,maxImage,maxMetadata];
  const instant = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) storageInvalid(); };
  return {
    authorize: auth,
    screenImage,
    screenMetadata,
    async put(raw, input) {
      // Detach before the first asynchronous authorization callback.
      if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > maxImage) storageInvalid();
      const record = validateStoredSnapshot(raw, maxMetadata), bytes = Uint8Array.from(input), binding = record.binding;
      if (bytes.byteLength > maxImage || bytes.byteLength !== record.imageSize || imageDigest(bytes) !== record.imageDigest) storageInvalid();
      await auth('write'); screenMetadata(record); await screenImage(bytes);
      await config.db.transaction(async tx => {
        await auth('write'); screenMetadata(record);
        await tx.query(`INSERT INTO sandbox_runtime_storage.images
          (scope_key,run_id,binding_digest,metadata,metadata_digest,image_digest,image_size,image)
          VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) ON CONFLICT (scope_key,run_id) DO NOTHING`,
          [key,binding.runId,runtimeBridgeDigest(binding),storageJson(record,maxMetadata),runtimeBridgeDigest(record),record.imageDigest,record.imageSize,Buffer.from(bytes)]);
        const row = (await tx.query<Row>(`${select} FOR UPDATE`, lookup(binding))).rows[0];
        if (!row) throw new Error('runtime_storage_publication_missing');
        const saved = checked(row,binding);
        if (runtimeBridgeDigest(saved.record) !== runtimeBridgeDigest(record)) throw new Error('runtime_storage_publication_conflict');
        await auth('write'); screenMetadata(record); await finishImage('write', bytes); screenMetadata(record);
      });
      await auth('write'); screenMetadata(record); await finishImage('write', bytes); screenMetadata(record);
    },
    async get(raw) {
      const binding = validateBinding(raw);
      await auth('read'); screenMetadata(binding);
      const value = await config.db.transaction(async tx => {
        await auth('read');
        const row = (await tx.query<Row>(`${select} FOR SHARE`,lookup(binding))).rows[0];
        const result = row ? checked(row,binding) : null;
        if (result) await screenImage(result.bytes);
        await auth('read');
        return result;
      });
      await auth('read');
      if (value) { screenMetadata(value.record); await finishImage('read', value.bytes); screenMetadata(value.record); }
      return value;
    },
    async retain(raw,until) {
      const binding = validateBinding(raw); instant(until); await auth('retain'); screenMetadata(binding);
      await config.db.transaction(async tx => {
        const row = (await tx.query<Row>(`${select} FOR UPDATE`,lookup(binding))).rows[0];
        if (!row) throw new Error('runtime_storage_missing');
        checked(row,binding);
        await auth('retain');
        await tx.query('UPDATE sandbox_runtime_storage.images SET needed=true,retain_until=GREATEST(retain_until,$3) WHERE scope_key=$1 AND run_id=$2',[key,binding.runId,until]);
        await auth('retain');
      });
      await auth('retain');
    },
    async releaseRetention(raw) {
      const binding = validateBinding(raw); await auth('release'); screenMetadata(binding);
      await config.db.transaction(async tx => {
        const row = (await tx.query<Row>(`${select} FOR UPDATE`,lookup(binding))).rows[0];
        if (!row) throw new Error('runtime_storage_missing');
        checked(row,binding);
        await auth('release');
        await tx.query('UPDATE sandbox_runtime_storage.images SET needed=false WHERE scope_key=$1 AND run_id=$2',[key,binding.runId]);
        await auth('release');
      });
      await auth('release');
    },
    async reap(now) {
      instant(now); await auth('reap');
      const count = await config.db.transaction(async tx => {
        await auth('reap');
        const result = await tx.query<{run_id:string}>(`WITH expired AS (SELECT run_id FROM sandbox_runtime_storage.images
          WHERE scope_key=$1 AND needed=false AND retain_until <= $2 AND image IS NOT NULL
          ORDER BY run_id LIMIT 100 FOR UPDATE SKIP LOCKED)
          UPDATE sandbox_runtime_storage.images AS images SET image=NULL FROM expired
          WHERE images.scope_key=$1 AND images.run_id=expired.run_id RETURNING images.run_id`,[key,now]);
        await auth('reap');
        return result.rows.length;
      });
      await auth('reap'); return count;
    },
  };
}

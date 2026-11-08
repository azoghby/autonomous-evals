import type { AgentTransactionalSql } from '../../agents/postgres-ports';
import { reviewDigest } from './binding';
import type { DataOperation, DataOperationLedger } from './operation-ledger';
import { inspectDataSafety } from './quality';

const invalid = () => new Error('data_operation_invalid');
const conflict = () => new Error('data_operation_immutable_conflict');
const unauthorized = () => new Error('data_operation_unauthorized');
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(v);
const digestValid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const MAX_BYTES = 1_000_000;

/** Validate without invoking getters/toJSON or silently losing JSON values. */
function encode(value: unknown): string {
  const seen = new Set<object>();
  function walk(item: unknown, depth: number): void {
    if (depth > 64) throw invalid();
    if (typeof item === 'string') { if (/[\u0000\uD800-\uDFFF]/u.test(item)) throw invalid(); return; }
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) throw invalid();
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw invalid();
    seen.add(item);
    const keys = Reflect.ownKeys(item);
    if (keys.some(k => typeof k !== 'string')) throw invalid();
    if (Array.isArray(item) && (Object.getPrototypeOf(item) !== Array.prototype || keys.length !== item.length + 1
      || item.length > MAX_BYTES || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)))) throw invalid();
    for (const key of keys) {
      if (Array.isArray(item) && key === 'length') continue;
      walk(key, depth + 1);
      const property = Object.getOwnPropertyDescriptor(item, key)!;
      if (!property.enumerable || !('value' in property)) throw invalid();
      walk(property.value, depth + 1);
    }
    seen.delete(item);
  }
  walk(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) throw invalid();
  return json;
}

export interface DataOperationReconciliation {
  tenantId: string;
  jobId: string;
  key: string;
  digest: string;
  resultDigest: string;
  /** Authenticated completing service and original immutable claim owner. */
  ownerId: string;
  claimOwnerId: string;
  receiptId: string;
}
export interface PostgresDataOperationScope {
  /** Trusted server authorization scope; never supplied by a provider or request body. */
  tenantId: string;
  jobId: string;
  /** Stable authorized service identity shared by its replicas and restarts. */
  ownerId: string;
  /** Resolve current service authentication on every mutation; fail closed for models/humans. */
  authenticateOwner(): Promise<{ ownerId: string } | null>;
  /** Verify a durable authenticated operator/provider receipt against EVERY supplied binding.
   * A nonempty receipt string alone is never authority. Do not call a model here. */
  authorizeReconciliation?(input: DataOperationReconciliation): Promise<boolean>;
  /** Re-evaluated on reads and writes, including replay. */
  knownSecrets?: readonly string[] | (() => readonly string[]);
}
type Row = { operation_key: string; digest: string; owner_id: string; state: string; result: unknown; result_digest: string | null; reconciliation_receipt: string | null };

/** Requires a pinned READ COMMITTED transaction, rollback on throw, no callback retries.
 * No migrations, provider calls, leases, expiry, owner takeover or automatic redispatch.
 * The DB role must be server-only, never a browser/model-accessible SQL credential. */
export function createPostgresDataOperationLedger(db: AgentTransactionalSql, scope: PostgresDataOperationScope): DataOperationLedger {
  const { tenantId, jobId, ownerId, authenticateOwner, authorizeReconciliation, knownSecrets = [] } = scope;
  if (![tenantId, jobId, ownerId].every(identifier) || typeof authenticateOwner !== 'function') throw invalid();
  const secrets = () => typeof knownSecrets === 'function' ? knownSecrets() : knownSecrets;
  function screen(value: unknown) {
    const snapshot: unknown = JSON.parse(encode(value));
    if (!inspectDataSafety(snapshot, secrets()).safe) throw invalid();
    return snapshot;
  }
  function keyParams(key: string) {
    if (typeof key !== 'string' || !key.length || key.length > 4096) throw invalid();
    screen({ tenantId, jobId, ownerId, key });
    return [tenantId, jobId, key];
  }
  async function authenticate() {
    const principal = await authenticateOwner();
    if (!principal || principal.ownerId !== ownerId) throw unauthorized();
  }
  function decode(row: Row, key: string): DataOperation {
    screen(row);
    if (row.operation_key !== key || !digestValid(row.digest) || !identifier(row.owner_id)
      || !['pending', 'complete'].includes(row.state)) throw invalid();
    if (row.state === 'pending') {
      if (row.result !== null || row.result_digest !== null || row.reconciliation_receipt !== null) throw invalid();
      return { key, digest: row.digest, state: 'pending' };
    }
    if (!digestValid(row.result_digest) || reviewDigest(row.result) !== row.result_digest
      || row.reconciliation_receipt !== null && !identifier(row.reconciliation_receipt)) throw invalid();
    return { key, digest: row.digest, state: 'complete', result: row.result,
      ...(row.reconciliation_receipt !== null ? { reconciliationReceipt: row.reconciliation_receipt } : {}) };
  }
  const select = 'SELECT operation_key, digest, owner_id, state, result, result_digest, reconciliation_receipt FROM evaluation_data_persistence.operations WHERE tenant_id = $1 AND job_id = $2 AND operation_key = $3';
  async function safe<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch (error) {
      if (error instanceof Error && [invalid().message, conflict().message, unauthorized().message].includes(error.message)) throw new Error(error.message);
      throw new Error('data_operation_failed');
    }
  }
  return {
    get: key => safe(async () => {
      const row = (await db.query<Row>(select, keyParams(key))).rows[0];
      return row ? decode(row, key) : null;
    }),
    claim: (key, digest) => safe(async () => {
      const params = keyParams(key);
      if (!digestValid(digest)) throw invalid();
      screen(digest);
      await authenticate();
      return db.transaction(async tx => {
        const inserted = (await tx.query<Row>('INSERT INTO evaluation_data_persistence.operations (tenant_id, job_id, operation_key, digest, owner_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, job_id, operation_key) DO NOTHING RETURNING operation_key, digest, owner_id, state, result, result_digest, reconciliation_receipt', [...params, digest, ownerId])).rows;
        const row = inserted[0] ?? (await tx.query<Row>(select, params)).rows[0];
        if (!row) throw invalid();
        const record = decode(row, key);
        if (record.digest !== digest) throw conflict();
        return { claimed: inserted.length > 0, record };
      });
    }),
    complete: (key, digest, result, reconciliationReceipt) => safe(async () => {
      const params = keyParams(key);
      if (!digestValid(digest) || reconciliationReceipt !== undefined && !identifier(reconciliationReceipt)) throw invalid();
      const snapshot = screen(result);
      const resultDigest = reviewDigest(snapshot);
      await authenticate();
      await db.transaction(async tx => {
        const row = (await tx.query<Row>(`${select} FOR UPDATE`, params)).rows[0];
        if (!row) throw conflict();
        const current = decode(row, key);
        if (current.digest !== digest) throw conflict();
        if (reconciliationReceipt !== undefined) {
          screen(reconciliationReceipt);
          if (!authorizeReconciliation || !await authorizeReconciliation({ tenantId, jobId, key, digest, resultDigest, ownerId, claimOwnerId: row.owner_id, receiptId: reconciliationReceipt })) throw unauthorized();
        } else if (row.owner_id !== ownerId) throw unauthorized();
        if (current.state === 'complete') {
          if (reviewDigest(current.result) !== resultDigest || current.reconciliationReceipt !== reconciliationReceipt) throw conflict();
          return;
        }
        const saved = (await tx.query<Row>('UPDATE evaluation_data_persistence.operations SET state = \'complete\', result = $4::jsonb, result_digest = $5, reconciliation_receipt = $6 WHERE tenant_id = $1 AND job_id = $2 AND operation_key = $3 RETURNING operation_key, digest, owner_id, state, result, result_digest, reconciliation_receipt', [...params, encode(snapshot), resultDigest, reconciliationReceipt ?? null])).rows[0];
        if (!saved) throw invalid();
        const completed = decode(saved, key);
        if (completed.state !== 'complete' || reviewDigest(completed.result) !== resultDigest || completed.reconciliationReceipt !== reconciliationReceipt) throw invalid();
      });
    }),
  };
}

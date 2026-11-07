import { randomUUID } from 'node:crypto';
import type { AgentTransactionalSql } from '../../agents/postgres-ports';

/** Identity is immutable within a job; changing the input requires a new id. */
export interface CheckpointKey {
  jobId: string;
  kind: string;
  id: string;
  inputDigest: string;
}
export type CheckpointLookup = Omit<CheckpointKey, 'inputDigest'> & { inputDigest?: string };
export type CheckpointValue =
  | { state: 'completed'; value: unknown }
  | { state: 'pending' }
  | { state: 'ambiguous' };
export type CheckpointClaim = CheckpointValue | { state: 'claimed'; token: string };

/** Claims never expire: a crashed external send must be reconciled by an operator,
 * not repeated by another Workflow worker. release is ONLY for safe resumptions
 * whose external dispatch is independently fenced: durable agent polling or an
 * enclosing scenario whose target intent remains pending/ambiguous. Never
 * release a target or judge dispatch checkpoint. */
export interface TextCheckpointStore {
  claim(key: CheckpointKey): Promise<CheckpointClaim>;
  get(key: CheckpointLookup): Promise<CheckpointValue | null>;
  complete(key: CheckpointKey, token: string, value: unknown): Promise<void>;
  release(key: CheckpointKey, token: string): Promise<void>;
  markAmbiguous(key: CheckpointKey, token: string): Promise<void>;
}

type Row = { input_digest: string; state: 'ready' | 'pending' | 'completed' | 'ambiguous'; token: string; value: unknown };
const identityParams = (key: CheckpointLookup): string[] => {
  for (const value of [key.jobId, key.kind, key.id, ...(key.inputDigest === undefined ? [] : [key.inputDigest])]) {
    if (typeof value !== 'string' || !value.length || value.length > 4096 || /[\u0000\uD800-\uDFFF]/u.test(value)) throw new Error('text_checkpoint_invalid_identity');
  }
  return [key.jobId, key.kind, key.id];
};
const assertDigest = (row: Row, key: CheckpointLookup): void => {
  if (key.inputDigest !== undefined && row.input_digest !== key.inputDigest) throw new Error('text_checkpoint_identity_conflict');
};
const project = (row: Row): CheckpointValue => row.state === 'completed'
  ? { state: 'completed', value: row.value }
  : { state: row.state === 'ready' ? 'pending' : row.state };

/** Strict JSON prevents silent undefined/nonfinite truncation before durable storage. */
function encode(value: unknown): string {
  const encoded = JSON.stringify(value, (key, item: unknown) => {
    if (/\u0000|[\uD800-\uDFFF]/u.test(key) || item === undefined || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint'
      || (typeof item === 'number' && !Number.isFinite(item)) || (typeof item === 'string' && /\u0000|[\uD800-\uDFFF]/u.test(item))) {
      throw new Error('text_checkpoint_invalid_json');
    }
    return item;
  });
  if (encoded === undefined) throw new Error('text_checkpoint_invalid_json');
  return encoded;
}

/** Uses the existing pinned-connection READ COMMITTED transaction pool contract.
 * Transactions must roll back on failure and must never retry their callbacks.
 * External calls are deliberately outside these short SQL transactions. */
export class PostgresTextCheckpointStore implements TextCheckpointStore {
  constructor(private readonly db: AgentTransactionalSql) {}

  async claim(key: CheckpointKey): Promise<CheckpointClaim> {
    const params = identityParams(key);
    const token = randomUUID();
    return this.db.transaction(async tx => {
      const inserted = await tx.query<Row>(`INSERT INTO text_integration.checkpoints(job_id, kind, id, input_digest, token, state)
        VALUES ($1, $2, $3, $4, $5, 'pending') ON CONFLICT DO NOTHING RETURNING *`, [...params, key.inputDigest, token]);
      const row = inserted.rows[0] ?? (await tx.query<Row>('SELECT * FROM text_integration.checkpoints WHERE job_id = $1 AND kind = $2 AND id = $3 FOR UPDATE', params)).rows[0];
      if (!row) throw new Error('text_checkpoint_missing');
      assertDigest(row, key);
      if (row.state === 'ready') {
        await tx.query("UPDATE text_integration.checkpoints SET state = 'pending', token = $4 WHERE job_id = $1 AND kind = $2 AND id = $3", [...params, token]);
        return { state: 'claimed', token };
      }
      return inserted.rows.length ? { state: 'claimed', token } : project(row);
    });
  }

  async get(key: CheckpointLookup): Promise<CheckpointValue | null> {
    const params = identityParams(key);
    const row = (await this.db.query<Row>('SELECT * FROM text_integration.checkpoints WHERE job_id = $1 AND kind = $2 AND id = $3', params)).rows[0];
    if (!row) return null;
    assertDigest(row, key);
    return project(row);
  }

  async complete(key: CheckpointKey, token: string, value: unknown): Promise<void> {
    const params = identityParams(key);
    const encoded = encode(value);
    await this.db.transaction(async tx => {
      const row = (await tx.query<Row>('SELECT * FROM text_integration.checkpoints WHERE job_id = $1 AND kind = $2 AND id = $3 FOR UPDATE', params)).rows[0];
      if (!row || row.token !== token) throw new Error('text_checkpoint_not_owner');
      assertDigest(row, key);
      if (row.state === 'ambiguous') throw new Error('text_checkpoint_ambiguous');
      if (row.state === 'ready') throw new Error('text_checkpoint_not_owner');
      if (row.state === 'completed') {
        const equal = (await tx.query<{ equal: boolean }>('SELECT $1::jsonb = $2::jsonb AS equal', [encode(row.value), encoded])).rows[0]?.equal;
        if (!equal) throw new Error('text_checkpoint_completion_conflict');
        return;
      }
      await tx.query(`UPDATE text_integration.checkpoints SET state = 'completed', value = $5::jsonb
        WHERE job_id = $1 AND kind = $2 AND id = $3 AND token = $4`, [...params, token, encoded]);
    });
  }

  async release(key: CheckpointKey, token: string): Promise<void> {
    const params = identityParams(key);
    const deleted = await this.db.query<{ input_digest: string }>(`UPDATE text_integration.checkpoints SET state = 'ready'
      WHERE job_id = $1 AND kind = $2 AND id = $3 AND token = $4 AND input_digest = $5 AND state = 'pending' RETURNING input_digest`, [...params, token, key.inputDigest]);
    if (!deleted.rows.length) throw new Error('text_checkpoint_not_releasable');
  }

  async markAmbiguous(key: CheckpointKey, token: string): Promise<void> {
    const params = identityParams(key);
    const saved = await this.db.query<Row>(`UPDATE text_integration.checkpoints SET state = 'ambiguous'
      WHERE job_id = $1 AND kind = $2 AND id = $3 AND token = $4 AND input_digest = $5 AND state IN ('pending', 'ambiguous') RETURNING *`, [...params, token, key.inputDigest]);
    if (!saved.rows.length) throw new Error('text_checkpoint_not_owner');
  }
}

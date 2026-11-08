import { CostEntry } from '../contracts/index';

export interface CostTransaction {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface CostSql {
  transaction<T>(fn: (tx: CostTransaction) => Promise<T>): Promise<T>;
}
export interface CostTarget {
  kind: 'job' | 'suite' | 'run'; id: string;
  /** Trusted caller snapshot. Workflow-only callers may resolve canonical ownership inside this transaction. */
  ownerId?: string; environment?: 'test' | 'live';
}
export class CostSettlementConflict extends Error {
  constructor() { super('Cost receipt conflicts with retained accounting evidence or requires reconciliation.'); }
}
const conflict = (): never => { throw new CostSettlementConflict(); };
const canonical = (v: unknown): string => {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype)
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return conflict();
};

/** Internal server boundary: callers must authorize the target before dispatch. The locked canonical
 * ownership snapshot is rechecked on every receipt replay. This function grants no dispatch authority.
 * Provider IDs are assumed globally unique within this installation's single Naive organization. */
export async function settleCost(sql: CostSql, rawTarget: CostTarget, rawEntry: unknown): Promise<{ inserted: boolean; microUsd: number }> {
  const target = { ...rawTarget };
  if (!['job','suite','run'].includes(target.kind) || !target.id || target.id.length > 200) conflict();
  const entry = CostEntry.omit({ jobId: true }).parse(rawEntry);
  const meta = JSON.parse(canonical(entry.meta)) as Record<string, unknown>;
  if (!Number.isSafeInteger(entry.microUsd) || entry.microUsd < 0) conflict();
  let receiptKey: string | null = null;
  if (entry.source === 'naive' || entry.source === 'naive_proxy') {
    const externalId = entry.source === 'naive' ? entry.sessionId : entry.requestId;
    const validId = entry.source === 'naive' ? /^ses_[0-9a-hjkmnp-tv-z]{26}$/ : /^req_[0-9a-hjkmnp-tv-z]{26}$/;
    if (!externalId || !validId.test(externalId) || meta.measured !== true ||
      typeof meta.purpose !== 'string' || !meta.purpose.trim() || meta.purpose.length > 200 ||
      (entry.source === 'naive_proxy' && (entry.agent !== 'judge' || entry.sessionId !== undefined)) ||
      (entry.source === 'naive' && entry.requestId !== undefined)) conflict();
    receiptKey = `${entry.source}:${externalId}`;
    if (meta.idempotencyKey !== undefined && meta.idempotencyKey !== receiptKey) conflict();
    meta.idempotencyKey = receiptKey;
  }
  return sql.transaction(async tx => {
    let scope: Record<string, unknown>;
    if (target.kind === 'job') {
      const row = (await tx.query<{ customer_id: string; environment: string }>(
        'SELECT customer_id, environment FROM jobs WHERE id=$1 FOR UPDATE', [target.id])).rows[0];
      if (!row || (target.ownerId !== undefined && target.ownerId !== row.customer_id) ||
          (target.environment !== undefined && target.environment !== row.environment)) return conflict();
      scope = { kind: 'job', id: target.id, ownerId: row.customer_id, environment: row.environment };
    } else {
      const table = target.kind === 'run' ? 'sandbox_runs' : 'sandbox_suites';
      const row = (await tx.query<{ owner_id: string; org_id: string | null; environment_id: string; environment_owner: string; environment_org: string | null }>(
        `SELECT t.owner_id,t.org_id,t.environment_id,e.owner_id AS environment_owner,e.org_id AS environment_org FROM ${table} t JOIN sandbox_environments e ON e.id=t.environment_id WHERE t.id=$1 FOR UPDATE OF t,e`, [target.id])).rows[0];
      if (!row || row.owner_id !== row.environment_owner || row.org_id !== row.environment_org ||
        (target.ownerId !== undefined && target.ownerId !== row.owner_id) || target.environment !== undefined) return conflict();
      scope = { kind: target.kind, id: target.id, ownerId: row.owner_id, orgId: row.org_id, environmentId: row.environment_id };
    }
    const identity = { scope, source: entry.source, agent: entry.agent ?? null, sessionId: entry.sessionId ?? null,
      requestId: entry.requestId ?? null, microUsd: entry.microUsd, meta };
    if (receiptKey) {
      // Old rows remain untouched. Their replay must not silently become a second charge.
      const legacy = await tx.query('SELECT id FROM costs WHERE source=$1 AND receipt_key IS NULL AND (session_id=$2 OR meta->>\'idempotencyKey\'=$3) LIMIT 1',
        [entry.source, entry.sessionId ?? entry.requestId, receiptKey]);
      if (legacy.rows.length) return conflict();
    }
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO costs(job_id,source,agent,session_id,micro_usd,meta,receipt_key,receipt_identity)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb) ON CONFLICT (source,receipt_key) WHERE receipt_key IS NOT NULL DO NOTHING RETURNING id`,
      [target.kind === 'job' ? target.id : null, entry.source, entry.agent ?? null, entry.sessionId ?? null, entry.microUsd,
        JSON.stringify({ ...meta, ...(target.kind === 'job' ? {} : { [target.kind === 'run' ? 'sandboxRunId' : 'sandboxSuiteId']: target.id }) }), receiptKey, receiptKey ? canonical(identity) : null]);
    if (!inserted.rows.length) {
      const retained = (await tx.query<{ receipt_identity: unknown }>('SELECT receipt_identity FROM costs WHERE source=$1 AND receipt_key=$2 FOR UPDATE', [entry.source, receiptKey])).rows[0];
      if (!retained || canonical(retained.receipt_identity) !== canonical(identity)) return conflict();
      return { inserted: false, microUsd: entry.microUsd };
    }
    if (target.kind !== 'job') {
      const table = target.kind === 'run' ? 'sandbox_runs' : 'sandbox_suites';
      const result = await tx.query<{ id: string }>(`UPDATE ${table} SET cost_micro_usd=cost_micro_usd+$1 WHERE id=$2 AND cost_micro_usd+$1 <= 9007199254740991 RETURNING id`, [entry.microUsd,target.id]);
      if (result.rows.length !== 1) return conflict();
    }
    return { inserted: true, microUsd: entry.microUsd };
  });
}

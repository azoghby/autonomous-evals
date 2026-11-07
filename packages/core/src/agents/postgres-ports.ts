import { AgentRoleSchema, AgentTaskStateSchema } from '../evals/types';
import type { AgentTaskStore, AgentTaskRecord, AgentTaskPatch, BudgetLedger, BudgetReservationRequest, BudgetReservationResult } from '../evals/types';

/** Structurally compatible with simulator/postgres and pooledCalendarDatabase. Must use a
 * pinned connection, READ COMMITTED isolation, rollback on failure, and no callback retries.
 * Neither Neon HTTP queries nor independent pool.query calls implement transaction(). */
export interface AgentSqlExecutor {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface AgentTransactionalSql extends AgentSqlExecutor {
  transaction<T>(fn: (tx: AgentSqlExecutor) => Promise<T>): Promise<T>;
}

function invalid(): never { throw new Error('agent_persistence_invalid_input'); }
function integer(value: unknown, min = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) invalid();
}
function string(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 4096 || /[\u0000\uD800-\uDFFF]/u.test(value)) invalid();
}
// PostgreSQL text/jsonb reject NUL and lone surrogates. Values are always parameters, never SQL fragments.
function json(value: unknown): string {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value, (_key, v: unknown) => {
    if (/\u0000|[\uD800-\uDFFF]/u.test(_key)) invalid();
    if (typeof v === 'number' && !Number.isFinite(v)) invalid();
    if (typeof v === 'string' && /\u0000|[\uD800-\uDFFF]/u.test(v)) invalid();
    if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') invalid();
    return v;
  }); } catch { invalid(); }
  if (!encoded) invalid();
  return encoded;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const immutable = ['taskKey', 'jobId', 'role', 'purpose', 'attempt', 'agentId', 'idempotencyKey', 'requestBody', 'reservationId', 'budgetMicroUsd', 'createdAt'] as const;
const mutable = new Set(['state', 'sessionId', 'agentVersion', 'consumedMicroUsd', 'tokenUsage', 'result', 'error', 'replayCount', 'leaseOwner', 'leaseExpiresAt', 'updatedAt']);
function validateTask(r: AgentTaskRecord): void {
  for (const key of ['taskKey', 'jobId', 'purpose', 'agentId', 'idempotencyKey', 'reservationId', 'createdAt', 'updatedAt'] as const) string(r[key]);
  if (!AgentRoleSchema.safeParse(r.role).success || !AgentTaskStateSchema.safeParse(r.state).success) invalid();
  integer(r.revision); integer(r.attempt, 1); integer(r.budgetMicroUsd, 1); integer(r.replayCount);
  if (r.agentVersion !== null) integer(r.agentVersion, 1);
  if (r.consumedMicroUsd !== null) integer(r.consumedMicroUsd);
  for (const key of ['sessionId', 'leaseOwner', 'leaseExpiresAt'] as const) if (r[key] !== null) string(r[key]);
  for (const key of ['createdAt', 'updatedAt', 'leaseExpiresAt'] as const) if (r[key] !== null && !Number.isFinite(Date.parse(r[key]!))) invalid();
  if (r.tokenUsage !== null) for (const amount of Object.values(r.tokenUsage)) integer(amount);
  if (r.requestBody.agent_id !== r.agentId || r.requestBody.budget_micro_usd !== r.budgetMicroUsd || r.requestBody.structured_output_required !== true) invalid();
  const body = r.requestBody;
  if (typeof body.message !== 'string') invalid();
  string(body.agent_id);
  if (body.agent_version !== undefined) integer(body.agent_version, 1);
  if (!body.output_schema || typeof body.output_schema !== 'object' || Array.isArray(body.output_schema) || !body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) invalid();
  for (const value of Object.values(body.metadata)) if (!['string', 'number', 'boolean'].includes(typeof value)) invalid();
  if (body.window !== undefined && !['immediate', 'priority', 'loose'].includes(body.window)) invalid();
  if (r.error !== null) { string(r.error.code); string(r.error.message); }
  json(r);
}
type TaskRow = { record: AgentTaskRecord; revision: string | number };
function task(row: TaskRow): AgentTaskRecord {
  const revision = Number(row.revision); integer(revision);
  const record = { ...row.record, revision }; validateTask(record); return record;
}

export class PostgresAgentTaskStore implements AgentTaskStore {
  constructor(private readonly db: AgentTransactionalSql) {}
  async get(taskKey: string): Promise<AgentTaskRecord | null> {
    string(taskKey);
    const { rows } = await this.db.query<TaskRow>('SELECT record, revision FROM agent_persistence.tasks WHERE task_key = $1', [taskKey]);
    return rows[0] ? task(rows[0]) : null;
  }
  async insertIfAbsent(record: AgentTaskRecord) {
    record = JSON.parse(json(record)) as AgentTaskRecord;
    validateTask(record);
    if (record.revision !== 0) invalid();
    return this.db.transaction(async tx => {
      const inserted = await tx.query<TaskRow>('INSERT INTO agent_persistence.tasks(task_key, revision, record) VALUES ($1, 0, $2::jsonb) ON CONFLICT DO NOTHING RETURNING record, revision', [record.taskKey, json(record)]);
      const row = inserted.rows[0] ?? (await tx.query<TaskRow>('SELECT record, revision FROM agent_persistence.tasks WHERE task_key = $1', [record.taskKey])).rows[0];
      if (!row) throw new Error('agent_persistence_missing_task');
      const stored = task(row);
      if (immutable.filter(k => k !== 'createdAt').some(k => canonical(stored[k]) !== canonical(record[k]))) throw new Error('agent_persistence_task_identity_conflict');
      return { inserted: !!inserted.rows.length, record: stored };
    });
  }
  async compareAndSet(taskKey: string, expectedRevision: number, patch: AgentTaskPatch) {
    string(taskKey); integer(expectedRevision);
    if (Object.keys(patch).some(k => !mutable.has(k))) invalid();
    patch = JSON.parse(json(patch)) as AgentTaskPatch;
    return this.db.transaction(async tx => {
      const row = (await tx.query<TaskRow>('SELECT record, revision FROM agent_persistence.tasks WHERE task_key = $1 FOR UPDATE', [taskKey])).rows[0];
      if (!row || Number(row.revision) !== expectedRevision) return null;
      const next = { ...task(row), ...patch, revision: expectedRevision + 1 };
      validateTask(next);
      const saved = await tx.query<TaskRow>('UPDATE agent_persistence.tasks SET record = $3::jsonb, revision = revision + 1 WHERE task_key = $1 AND revision = $2 RETURNING record, revision', [taskKey, expectedRevision, json(next)]);
      return saved.rows[0] ? task(saved.rows[0]) : null;
    });
  }
}

type ReservationRow = { job_id: string; amount_micro_usd: string | number; scopes: BudgetReservationRequest['scopes']; first_result: BudgetReservationResult | null; settled_micro_usd: string | number | null };
function request(req: BudgetReservationRequest): BudgetReservationRequest {
  string(req.reservationId); string(req.jobId); integer(req.amountMicroUsd, 1);
  if (!Array.isArray(req.scopes) || req.scopes.length < 1 || req.scopes.length > 64) invalid();
  const scopes = req.scopes.map(s => { string(s.key); integer(s.capMicroUsd); return { key: s.key, capMicroUsd: s.capMicroUsd }; }).sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  if (new Set(scopes.map(s => s.key)).size !== scopes.length) invalid();
  // A reservation must count against its job and at least one role-period scope.
  if (!scopes.some(s => s.key === `job:${req.jobId}`) || !scopes.some(s => /^agent:(commercial|evaluation_engineer|quality_investigator|company_operator):[A-Za-z0-9_-]+$/.test(s.key))) invalid();
  return { ...req, scopes };
}
async function lockScopes(tx: AgentSqlExecutor, scopes: BudgetReservationRequest['scopes']) {
  for (const s of scopes) {
    await tx.query('INSERT INTO agent_persistence.scopes(key, cap_micro_usd) VALUES ($1, $2) ON CONFLICT DO NOTHING', [s.key, s.capMicroUsd]);
    const row = (await tx.query<{ cap_micro_usd: string | number }>('SELECT cap_micro_usd FROM agent_persistence.scopes WHERE key = $1 FOR UPDATE', [s.key])).rows[0];
    if (!row || BigInt(row.cap_micro_usd) !== BigInt(s.capMicroUsd)) throw new Error('agent_persistence_scope_cap_conflict');
  }
}
export class PostgresBudgetLedger implements BudgetLedger {
  constructor(private readonly db: AgentTransactionalSql) {}
  async reserve(input: BudgetReservationRequest): Promise<BudgetReservationResult> {
    const req = request(input);
    return this.db.transaction(async tx => {
      await tx.query('INSERT INTO agent_persistence.reservations(id, job_id, amount_micro_usd, scopes) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING', [req.reservationId, req.jobId, req.amountMicroUsd, json(req.scopes)]);
      const row = (await tx.query<ReservationRow>('SELECT * FROM agent_persistence.reservations WHERE id = $1 FOR UPDATE', [req.reservationId])).rows[0]!;
      if (row.job_id !== req.jobId || BigInt(row.amount_micro_usd) !== BigInt(req.amountMicroUsd) || canonical(row.scopes) !== canonical(req.scopes)) throw new Error('agent_persistence_reservation_identity_conflict');
      if (row.first_result) return row.first_result.ok ? { ...row.first_result, replayed: true } : row.first_result;
      await lockScopes(tx, req.scopes);
      let result: BudgetReservationResult = { ok: true, reservationId: req.reservationId, replayed: false };
      for (const scope of req.scopes) {
        const sum = (await tx.query<{ committed: string }>(`SELECT COALESCE(SUM(COALESCE(settled_micro_usd, amount_micro_usd)), 0)::text AS committed
          FROM agent_persistence.reservations WHERE first_result->>'ok' = 'true' AND scopes @> $1::jsonb`, [json([{ key: scope.key }])])).rows[0]!;
        const available = BigInt(scope.capMicroUsd) - BigInt(sum.committed);
        if (available < BigInt(req.amountMicroUsd)) {
          result = { ok: false, reservationId: req.reservationId, exhaustedScope: scope.key, capMicroUsd: scope.capMicroUsd, availableMicroUsd: Number(available > 0n ? available : 0n) };
          break;
        }
      }
      await tx.query('UPDATE agent_persistence.reservations SET first_result = $2::jsonb WHERE id = $1', [req.reservationId, json(result)]);
      return result;
    });
  }
  async settle(reservationId: string, consumedMicroUsd: number) {
    string(reservationId); integer(consumedMicroUsd);
    return this.db.transaction(async tx => {
      const row = (await tx.query<ReservationRow>('SELECT * FROM agent_persistence.reservations WHERE id = $1 FOR UPDATE', [reservationId])).rows[0];
      if (!row?.first_result?.ok) throw new Error('agent_persistence_unknown_reservation');
      if (row.settled_micro_usd !== null) return { settledMicroUsd: Number(row.settled_micro_usd), replayed: true };
      await lockScopes(tx, row.scopes);
      await tx.query('UPDATE agent_persistence.reservations SET settled_micro_usd = $2 WHERE id = $1 AND settled_micro_usd IS NULL', [reservationId, consumedMicroUsd]);
      return { settledMicroUsd: consumedMicroUsd, replayed: false };
    });
  }
}

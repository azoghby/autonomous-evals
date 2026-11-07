import { z } from 'zod';
import type { BranchLedger, BranchOwnership } from './neon';
import type { SqlPool } from './pool';
import { isPersistableText } from '../targets/chat';

const jobSchema = z.string().min(1).max(128).refine(isPersistableText);
const branchIdSchema = z.string().regex(/^br-[a-z0-9-]+$/).max(128);
const ownershipSchema = z.object({
  jobId: jobSchema,
  projectId: z.string().regex(/^[a-z0-9-]{1,60}$/),
  parentId: branchIdSchema,
  name: z.string().regex(/^eval-job-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  branchId: branchIdSchema.optional(),
  state: z.enum(['creating', 'retryable', 'ready', 'delete_requested', 'deleted']),
  createAttempts: z.number().int().min(1).max(3).optional(),
}).strict().refine((r) => r.branchId !== r.parentId)
  .refine((r) => ['creating', 'retryable'].includes(r.state) ? r.branchId === undefined : r.branchId !== undefined);
const rowSchema = z.object({
  job_id: z.unknown(), project_id: z.unknown(), parent_id: z.unknown(),
  name: z.unknown(), branch_id: z.unknown(), state: z.unknown(), create_attempts: z.unknown(),
}).strict();
const columns = 'job_id, project_id, parent_id, name, branch_id, state, create_attempts';

function parseRecord(value: unknown): BranchOwnership {
  const parsed = ownershipSchema.safeParse(value);
  if (!parsed.success) throw new Error('branch_ledger_invalid_record');
  return parsed.data;
}
function parseRow(value: unknown): BranchOwnership {
  const row = rowSchema.safeParse(value);
  if (!row.success) throw new Error('branch_ledger_invalid_record');
  const r = row.data;
  return parseRecord({ jobId: r.job_id, projectId: r.project_id, parentId: r.parent_id,
    name: r.name, ...(r.branch_id === null ? {} : { branchId: r.branch_id }), state: r.state, ...(r.create_attempts === null ? {} : { createAttempts: r.create_attempts }) });
}
function validateJob(jobId: string) {
  if (!jobSchema.safeParse(jobId).success) throw new Error('branch_ledger_invalid_job');
}

/** Application-database ledger. Requires a direct/session-mode pg pool, never transaction pooling. */
export class PostgresBranchLedger implements BranchLedger {
  constructor(private readonly pool: SqlPool) {}

  async findOwnedBranch(branchId: string): Promise<BranchOwnership | undefined> {
    if (!branchIdSchema.safeParse(branchId).success) throw new Error('branch_ledger_invalid_branch');
    let rows: unknown[];
    try { ({ rows } = await this.pool.query(`SELECT ${columns} FROM app_branch_ownership WHERE branch_id = $1`, [branchId])); }
    catch { throw new Error('branch_ledger_read_failed'); }
    if (rows.length > 1) throw new Error('branch_ledger_invalid_record');
    const record = rows.length ? parseRow(rows[0]) : undefined;
    if (record && record.branchId !== branchId) throw new Error('branch_ledger_invalid_record');
    return record;
  }

  async withJobLock<T>(jobId: string, fn: (record: BranchOwnership | undefined, put: (record: BranchOwnership) => Promise<void>) => Promise<T>): Promise<T> {
    validateJob(jobId);
    // Database errors can contain parameters/connection details. Expose safe codes only.
    const connection = await this.pool.connect().catch(() => { throw new Error('branch_ledger_connect_failed'); });
    const key = `autonomous-evals:branch-ledger:${jobId}`;
    let active = false;
    let locked = false;
    let discard: Error | undefined;
    let failure: unknown;
    let failed = false;
    let result!: T;
    let writeFailure: unknown;
    let tail: Promise<void> = Promise.resolve();
    const query = async (sql: string, params: unknown[]) => {
      try { return await connection.query(sql, params); }
      catch {
        discard = new Error('branch_ledger_sql_failed');
        throw discard;
      }
    };
    try {
      // Session lock survives statement commits; no BEGIN around the callback.
      // Hash collisions only serialize unrelated jobs; they cannot remove exclusivity.
      await query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
      locked = true;
      const { rows } = await query(`SELECT ${columns} FROM app_branch_ownership WHERE job_id = $1`, [jobId]);
      if (rows.length > 1) throw new Error('branch_ledger_invalid_record');
      const record = rows.length ? parseRow(rows[0]) : undefined;
      if (record && record.jobId !== jobId) throw new Error('branch_ledger_invalid_record');
      active = true;
      const put = (value: BranchOwnership): Promise<void> => {
        if (!active) return Promise.reject(new Error('branch_ledger_closed'));
        // Copy/validate immediately so callers cannot mutate a queued write.
        let next: BranchOwnership;
        try {
          next = parseRecord(value);
          if (next.jobId !== jobId) throw new Error('branch_ledger_job_mismatch');
        } catch (error) { return Promise.reject(error); }
        const pending = tail.then(async () => {
          if (writeFailure) throw writeFailure;
          const saved = await query(`INSERT INTO app_branch_ownership (${columns})
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (job_id) DO UPDATE SET branch_id = EXCLUDED.branch_id, state = EXCLUDED.state, create_attempts = EXCLUDED.create_attempts
            WHERE app_branch_ownership.project_id = EXCLUDED.project_id
              AND app_branch_ownership.parent_id = EXCLUDED.parent_id
              AND app_branch_ownership.name = EXCLUDED.name
              AND (app_branch_ownership.branch_id IS NULL OR app_branch_ownership.branch_id = EXCLUDED.branch_id)
              AND (
                (app_branch_ownership.state = 'retryable' AND EXCLUDED.state = 'creating'
                  AND EXCLUDED.create_attempts = COALESCE(app_branch_ownership.create_attempts, 1) + 1)
                OR (COALESCE(app_branch_ownership.create_attempts, 1) = COALESCE(EXCLUDED.create_attempts, 1)
                  AND (app_branch_ownership.state = EXCLUDED.state
                    OR (app_branch_ownership.state = 'creating' AND EXCLUDED.state IN ('retryable','ready','delete_requested','deleted'))
                    OR (app_branch_ownership.state = 'ready' AND EXCLUDED.state IN ('delete_requested','deleted'))
                    OR (app_branch_ownership.state = 'delete_requested' AND EXCLUDED.state IN ('ready','deleted')))))
            RETURNING ${columns}`, [next.jobId, next.projectId, next.parentId, next.name, next.branchId ?? null, next.state, next.createAttempts ?? null]);
          if (saved.rows.length !== 1) throw new Error('branch_ledger_ownership_conflict');
          parseRow(saved.rows[0]);
          // A pg query outside a transaction resolves after its autocommit completes.
        });
        tail = pending.catch((error: unknown) => { writeFailure ??= error; });
        return pending;
      };
      try { result = await fn(record, put); }
      finally { active = false; }
    } catch (error) {
      failure = error; failed = true;
      if (!locked) discard = new Error('branch_ledger_lock_failed');
    } finally {
      active = false;
      // Even a callback that forgot to await put cannot release a connection with writes in flight.
      await tail;
      if (!failed && writeFailure) { failure = writeFailure; failed = true; }
      if (locked) {
        try {
          const unlocked = await query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [key]);
          if (unlocked.rows.length !== 1 || (unlocked.rows[0] as { unlocked?: unknown })?.unlocked !== true) {
            throw new Error('branch_ledger_unlock_failed');
          }
        } catch {
          discard = new Error('branch_ledger_unlock_failed');
          if (!failed) { failure = discard; failed = true; }
        }
      }
      try { connection.release(discard); }
      catch {
        // A custom pool may throw before releasing. Try destroying it explicitly.
        try { connection.release(new Error('branch_ledger_release_failed')); } catch { /* Pool must honor destroy-on-error. */ }
        if (!failed) { failure = new Error('branch_ledger_release_failed'); failed = true; }
      }
    }
    if (failed) throw failure;
    return result;
  }
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { isPersistableText, toolCallSchema } from '../../targets/chat';
import { stateExpectationSchema } from '../graders';
import type { SqlConnection, SqlPool } from '../pool';
import type { WorkflowInvestigationJournal, WorkflowInvestigationRecord } from './index';

const id = z.string().min(1).max(128).refine(isPersistableText);
const text = z.string().refine(isPersistableText);
const scope = z.object({ jobId: id, runId: id, version: id }).strict();
const event = z.object({ id, calendarId: id, ownerId: id, title: text,
  startUtc: z.string().datetime(), endUtc: z.string().datetime(), timeZone: text,
  status: z.enum(['active', 'cancelled']) }).strict();
const toolResult = z.object({ ok: z.boolean(), code: text, events: z.array(event).optional(), event: event.optional() }).strict();
const state = z.object({ calendars: z.array(z.object({ id, ownerId: id }).strict()),
  permissions: z.array(z.object({ calendarId: id, actorId: id, access: z.enum(['read', 'write']) }).strict()),
  events: z.array(event), calls: z.array(z.object({ id, actorId: id, name: text, arguments: text, result: toolResult }).strict()),
  failNextMutation: z.boolean() }).strict();
const message = z.union([
  z.object({ role: z.enum(['system', 'user']), content: text }).strict(),
  z.object({ role: z.literal('assistant'), content: text.nullable().optional(), tool_calls: z.array(toolCallSchema).max(8).optional() }).strict(),
  z.object({ role: z.literal('tool'), content: text, tool_call_id: id }).strict(),
]);
const grade = z.object({ passed: z.boolean(), results: z.array(z.object({ check: stateExpectationSchema, passed: z.boolean() }).strict()).min(1).max(100) }).strict()
  .refine(g => g.passed === g.results.every(r => r.passed));
const result = z.object({ scenarioId: id, scope, outcome: z.enum(['passed', 'product_failure', 'inconclusive', 'infrastructure_error']), reason: text,
  execution: z.object({ scope, scenarioId: id, messages: z.array(message), state,
    stopped: z.enum(['complete', 'round_limit', 'invalid_response', 'target_error', 'simulator_error']),
    rounds: z.number().int().min(0).max(6), rejectedResponse: text.optional() }).strict().optional(),
  partialState: state.optional(), stateGrade: grade.optional(), claim: z.enum(['success', 'no_success', 'unknown']).optional(), claimGrade: grade.optional(),
}).strict();
const recordSchema = z.object({ original: z.object({ jobId: id, branchId: id, runId: id,
  suiteHash: z.string().regex(/^[a-f0-9]{64}$/), versionLabel: id,
  origin: z.enum(['customer', 'internal_fixture']), systemPrompt: text.max(20_000).optional(), results: z.array(result).max(12),
}).strict(), attempts: z.array(z.object({ scenarioId: id, result: result.optional() }).strict()).max(3) }).strict();

function fail(code: string): never { throw new Error(`workflow_journal_${code}`); }
/** Reject non-JSON values before stringify can silently discard/transform them. Undefined object
 * properties are allowed because the workflow emits optional properties explicitly. */
function json(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 100) fail('invalid_record');
  if (typeof value === 'string') { if (!isPersistableText(value)) fail('invalid_record'); return; }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (!value || typeof value !== 'object' || ancestors.has(value)) fail('invalid_record');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('invalid_record');
  ancestors.add(value);
  if (Object.getOwnPropertySymbols(value).length) fail('invalid_record');
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) json(value[i], ancestors, depth + 1);
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (!isPersistableText(key)) fail('invalid_record');
      if (entry !== undefined) json(entry, ancestors, depth + 1);
    }
  }
  ancestors.delete(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function parse(value: unknown): WorkflowInvestigationRecord {
  try {
    json(value);
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success) fail('invalid_record');
    const r = parsed.data;
    const o = r.original;
    if (new Set(o.results.map(v => v.scenarioId)).size !== o.results.length) fail('invalid_record');
    const candidates = o.results.filter(v => v.outcome === 'product_failure').slice(0, 3);
    const validResult = (v: z.infer<typeof result>) => v.scope.jobId === o.jobId && v.scope.version === o.versionLabel &&
      (!v.execution || (v.execution.scenarioId === v.scenarioId && canonical(v.execution.scope) === canonical(v.scope)));
    if (o.results.some(v => !validResult(v))) fail('invalid_record');
    if (r.attempts.some((a, i) => a.scenarioId !== candidates[i]?.scenarioId || (a.result &&
      (a.result.scenarioId !== a.scenarioId || !validResult(a.result) || a.result.scope.runId === candidates[i]?.scope.runId)))) fail('invalid_record');
    return r;
  } catch { return fail('invalid_record'); }
}
function transition(before: WorkflowInvestigationRecord | undefined, after: WorkflowInvestigationRecord) {
  if (!before) { if (after.attempts.length) fail('transition_conflict'); return; }
  if (canonical(before.original) !== canonical(after.original)) fail('original_mismatch');
  if (after.attempts.length < before.attempts.length || after.attempts.length > before.attempts.length + 1) fail('transition_conflict');
  for (let i = 0; i < before.attempts.length; i++) {
    const a = before.attempts[i]!; const b = after.attempts[i]!;
    if (a.scenarioId !== b.scenarioId || (a.result && canonical(a.result) !== canonical(b.result))) fail('transition_conflict');
  }
  // New work must first be committed as a pending intent, never as a completed attempt.
  if (after.attempts.length > before.attempts.length && after.attempts.at(-1)?.result) fail('transition_conflict');
}
interface Session {
  key: string; connection: SqlConnection; active: boolean; tail: Promise<void>;
  failure?: Error; discard?: Error;
}

/** Direct/session-mode pg pool only. No transaction may surround the callback: each save
 * must commit before external dispatch. An HTTP SQL adapter cannot implement this contract. */
export class PostgresWorkflowInvestigationJournal implements WorkflowInvestigationJournal {
  private readonly context = new AsyncLocalStorage<Session>();
  constructor(private readonly pool: SqlPool, private readonly tenantId: string) {
    if (!id.safeParse(tenantId).success) fail('invalid_tenant');
  }
  private validateKey(key: string) {
    if (typeof key !== 'string' || !key.length || key.length > 1024 || !isPersistableText(key)) fail('invalid_key');
  }
  private session(key: string): Session {
    this.validateKey(key);
    const s = this.context.getStore();
    if (!s || !s.active || s.key !== key) fail('lock_required');
    return s;
  }
  private async query(s: Session, sql: string, params: unknown[]) {
    if (s.failure) throw s.failure;
    try { return await s.connection.query(sql, params); }
    catch { s.discard = new Error('workflow_journal_sql_failed'); s.failure = s.discard; throw s.failure; }
  }
  private enqueue<T>(s: Session, fn: () => Promise<T>): Promise<T> {
    const work = s.tail.then(() => { if (s.failure) throw s.failure; return fn(); });
    s.tail = work.then(() => {}, () => { s.failure ??= new Error('workflow_journal_operation_failed'); });
    return work;
  }
  private async read(s: Session): Promise<WorkflowInvestigationRecord | undefined> {
    const { rows } = await this.query(s, 'SELECT tenant_id, journal_key, record FROM app_workflow_investigation_journals WHERE tenant_id=$1 AND journal_key=$2', [this.tenantId, s.key]);
    if (rows.length > 1) fail('invalid_record');
    if (!rows.length) return undefined;
    const row = rows[0] as { tenant_id?: unknown; journal_key?: unknown; record?: unknown } | null;
    if (!row || row.tenant_id !== this.tenantId || row.journal_key !== s.key) fail('invalid_record');
    return parse(row.record);
  }
  async load(key: string): Promise<WorkflowInvestigationRecord | undefined> {
    const s = this.session(key);
    return this.enqueue(s, () => this.read(s));
  }
  async save(key: string, record: WorkflowInvestigationRecord): Promise<void> {
    const s = this.session(key);
    const next = parse(record); // Copy immediately, before a queued operation can observe caller mutation.
    await this.enqueue(s, async () => {
      const before = await this.read(s);
      transition(before, next);
      const { rows } = await this.query(s, `INSERT INTO app_workflow_investigation_journals (tenant_id, journal_key, record)
        VALUES ($1, $2, $3::jsonb) ON CONFLICT (tenant_id, journal_key) DO UPDATE SET record=EXCLUDED.record
        WHERE app_workflow_investigation_journals.record=$4::jsonb RETURNING tenant_id`,
      [this.tenantId, key, JSON.stringify(next), before ? JSON.stringify(before) : null]);
      if (rows.length !== 1) fail('transition_conflict');
      // node-postgres resolves after the autocommit completes. No callback or SQL retries.
    });
  }
  async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    this.validateKey(key);
    if (this.context.getStore()) fail('nested_lock');
    let connection: SqlConnection;
    try { connection = await this.pool.connect(); } catch { return fail('connect_failed'); }
    const s: Session = { key, connection, active: false, tail: Promise.resolve() };
    // Tuple encoding prevents tenant/key delimiter collisions. Hash collisions only over-serialize.
    const lock = JSON.stringify(['autonomous-evals:workflow-journal:v1', this.tenantId, key]);
    let locked = false; let failed = false; let failure: unknown; let output!: T;
    try {
      await this.query(s, 'SELECT pg_advisory_lock(hashtextextended($1, 0))', [lock]);
      locked = true; s.active = true;
      try { output = await this.context.run(s, action); } finally { s.active = false; }
    } catch (error) { failed = true; failure = error; }
    finally {
      s.active = false;
      await s.tail;
      if (!failed && s.failure) { failed = true; failure = s.failure; }
      if (locked) {
        try {
          // Cleanup must still run after a failed operation, bypassing the poisoned query wrapper.
          const { rows } = await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked', [lock]);
          if (rows.length !== 1 || (rows[0] as { unlocked?: unknown })?.unlocked !== true) fail('unlock_failed');
        } catch { s.discard = new Error('workflow_journal_unlock_failed'); if (!failed) { failed = true; failure = s.discard; } }
      } else { s.discard ??= new Error('workflow_journal_lock_failed'); }
      try { connection.release(s.discard); }
      catch {
        try { connection.release(new Error('workflow_journal_release_failed')); } catch { /* Pool must destroy on error. */ }
        if (!failed) { failed = true; failure = new Error('workflow_journal_release_failed'); }
      }
    }
    if (failed) throw failure;
    return output;
  }
}

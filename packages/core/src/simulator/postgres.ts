import type { CalendarState, CalendarStore, RunScope } from './calendar';
import { scopeKey } from './calendar';
export interface QueryResult<T> { rows: T[] }
export interface QueryExecutor { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> }
export interface TransactionalDatabase extends QueryExecutor {
  /** A pinned connection with BEGIN/COMMIT/ROLLBACK. Do not emulate with pooled one-shot queries. */
  transaction<T>(fn: (tx: QueryExecutor) => Promise<T>): Promise<T>;
}
export function scopeParams(s: RunScope) { scopeKey(s); return [s.jobId, s.runId, s.version]; }
export class PostgresCalendarStore implements CalendarStore {
  constructor(readonly db: TransactionalDatabase) {}
  async create(scope: RunScope, seed: CalendarState) {
    await this.db.transaction(async tx => {
      await tx.query('INSERT INTO sim_runs(job_id,run_id,version,fail_next_mutation) VALUES($1,$2,$3,$4)', [...scopeParams(scope), seed.failNextMutation]);
      await this.write(tx, scope, seed);
    });
  }
  async transact<T>(scope: RunScope, action: (state: CalendarState) => T): Promise<T> {
    return this.db.transaction(async tx => {
      const state = await this.read(tx, scope, true);
      const result = action(state); await this.write(tx, scope, state); return result;
    });
  }
  async snapshot(scope: RunScope) { return this.db.transaction(tx => this.read(tx, scope, true)); }
  async reset(scope: RunScope) { await this.db.query('DELETE FROM sim_runs WHERE job_id=$1 AND run_id=$2 AND version=$3', scopeParams(scope)); }
  private async read(tx: QueryExecutor, scope: RunScope, lock: boolean): Promise<CalendarState> {
    const p = scopeParams(scope); const where = ' WHERE job_id=$1 AND run_id=$2 AND version=$3';
    const run = await tx.query<{ fail_next_mutation: boolean }>('SELECT fail_next_mutation FROM sim_runs' + where + (lock ? ' FOR UPDATE' : ''), p);
    if (!run.rows[0]) throw new Error('run_missing');
    const calendars = await tx.query<CalendarState['calendars'][number]>('SELECT id,owner_id AS "ownerId" FROM sim_calendars' + where, p);
    const permissions = await tx.query<CalendarState['permissions'][number]>('SELECT calendar_id AS "calendarId",actor_id AS "actorId",access FROM sim_permissions' + where, p);
    const events = await tx.query<Record<string, unknown>>('SELECT id,calendar_id AS "calendarId",owner_id AS "ownerId",title,start_utc AS "startUtc",end_utc AS "endUtc",time_zone AS "timeZone",status FROM sim_events' + where, p);
    const calls = await tx.query<CalendarState['calls'][number]>('SELECT id,actor_id AS "actorId",name,arguments,result FROM sim_tool_calls' + where, p);
    return { calendars: calendars.rows, permissions: permissions.rows, events: events.rows.map(e => ({ ...e, startUtc: new Date(e.startUtc as string).toISOString(), endUtc: new Date(e.endUtc as string).toISOString() })) as CalendarState['events'], calls: calls.rows, failNextMutation: run.rows[0].fail_next_mutation };
  }
  private async write(tx: QueryExecutor, scope: RunScope, state: CalendarState) {
    const p = scopeParams(scope);
    // Run row lock serializes mutations, including conflict and idempotency decisions.
    await tx.query('UPDATE sim_runs SET fail_next_mutation=$4 WHERE job_id=$1 AND run_id=$2 AND version=$3', [...p, state.failNextMutation]);
    for (const table of ['sim_tool_calls', 'sim_events', 'sim_permissions', 'sim_calendars']) await tx.query(`DELETE FROM ${table} WHERE job_id=$1 AND run_id=$2 AND version=$3`, p);
    for (const c of state.calendars) await tx.query('INSERT INTO sim_calendars VALUES($1,$2,$3,$4,$5)', [...p, c.id, c.ownerId]);
    for (const a of state.permissions) await tx.query('INSERT INTO sim_permissions VALUES($1,$2,$3,$4,$5,$6)', [...p, a.calendarId, a.actorId, a.access]);
    for (const e of state.events) await tx.query('INSERT INTO sim_events VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [...p, e.id, e.calendarId, e.ownerId, e.title, e.startUtc, e.endUtc, e.timeZone, e.status]);
    for (const c of state.calls) await tx.query('INSERT INTO sim_tool_calls VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [...p, c.id, c.actorId, c.name, c.arguments, JSON.stringify(c.result)]);
  }
}

import { readFile } from 'node:fs/promises';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { CalendarSimulator, MemoryCalendarStore, calendarSeed, type CalendarStore, type RunScope } from './calendar.js';
import { PostgresCalendarStore, type TransactionalDatabase, type QueryExecutor } from './postgres.js';
import { gradeCalendarState, gradeSuccessClaim } from './graders.js';
import { runCalendarScenario, reproduceCalendar, compareCalendar } from './runner.js';
import { internalCalendarFixture } from './fixtures.js';
import type { ToolCall } from '../targets/chat.js';
const scope = (version = 'v1'): RunScope => ({ jobId: 'job', runId: crypto.randomUUID(), version });
const args = { calendarId: 'personal', title: 'Interview', startUtc: '2026-11-08T19:00:00Z', endUtc: '2026-11-08T20:00:00Z', timeZone: 'America/Los_Angeles' };
const call = (name = 'create_event', a: unknown = args, id: string = crypto.randomUUID()): ToolCall => ({ id, type: 'function', function: { name, arguments: JSON.stringify(a) } });
let pg: PGlite; let db: TransactionalDatabase;
beforeAll(async () => {
  pg = new PGlite(); await pg.exec(await readFile(new URL('./migrations/001_calendar.sql', import.meta.url), 'utf8'));
  db = { query: (sql, p) => pg.query(sql, p), transaction: fn => pg.transaction(tx => fn({ query: (sql, p) => tx.query(sql, p) })) };
}, 30_000);
afterAll(async () => { await pg.close(); });
for (const backend of ['memory', 'postgres'] as const) describe(`${backend} calendar`, () => {
  const store = (): CalendarStore => backend === 'memory' ? new MemoryCalendarStore() : new PostgresCalendarStore(db);
  it('enforces permission before mutations and hides missing objects', async () => {
    const s = store(); const sc = scope(); await s.create(sc, calendarSeed()); const sim = new CalendarSimulator(s);
    expect(await sim.execute(sc, 'alice', call('create_event', { ...args, calendarId: 'restricted' }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await sim.execute(sc, 'mallory', call('cancel_event', { eventId: 'existing' }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect((await s.snapshot(sc)).events).toEqual(calendarSeed().events);
  });
  it('serializes duplicate bookings and retries idempotently', async () => {
    const s = store(); const sc = scope(); await s.create(sc, calendarSeed()); const sim = new CalendarSimulator(s); const c = call();
    const results = await Promise.all([sim.execute(sc, 'alice', c), sim.execute(sc, 'alice', call())]);
    expect(results.map(r => r.code).sort()).toEqual(['created','duplicate']);
    expect(await sim.execute(sc, 'alice', c)).toEqual(results[0]);
    expect(await sim.execute(sc, 'alice', call('cancel_event', { eventId: 'existing' }, c.id))).toMatchObject({ code: 'idempotency_conflict' });
    expect((await s.snapshot(sc)).events).toHaveLength(2);
  });
  it('rejects overlaps; permits adjacent bookings; update/cancel are scoped', async () => {
    const s = store(); const sc = scope(); await s.create(sc, calendarSeed()); const sim = new CalendarSimulator(s);
    expect(await sim.execute(sc, 'alice', call('create_event', { ...args, startUtc: '2026-11-08T17:30:00Z' }))).toMatchObject({ code: 'conflict' });
    expect(await sim.execute(sc, 'alice', call('create_event', { ...args, startUtc: '2026-11-08T18:00:00Z' }))).toMatchObject({ code: 'created' });
    const { calendarId: _, ...fields } = args;
    expect(await sim.execute(sc, 'alice', call('update_event', { eventId: 'existing', ...fields }))).toMatchObject({ code: 'conflict' });
    expect(await sim.execute(sc, 'alice', call('cancel_event', { eventId: 'existing' }))).toMatchObject({ code: 'cancelled' });
    expect(await sim.execute(sc, 'alice', call('cancel_event', { eventId: 'existing' }))).toMatchObject({ code: 'already_cancelled' });
  });
  it('requires UTC instants and valid explicit IANA zone, accepts DST fold instants', async () => {
    const s = store(); const sc = scope(); await s.create(sc, calendarSeed()); const sim = new CalendarSimulator(s);
    for (const patch of [{ timeZone: 'Mars/Olympus' }, { timeZone: 'PST' }, { startUtc: '2026-11-08T19:00:00' }, { startUtc: '2026-11-08T11:00:00-08:00' }, { startUtc: args.endUtc }, { ownerId: 'bob' }]) expect((await sim.execute(sc, 'alice', call('create_event', { ...args, ...patch }))).ok).toBe(false);
    expect(await sim.execute(sc, 'alice', call('create_event', { ...args, startUtc: '2026-11-01T08:30:00Z', endUtc: '2026-11-01T09:30:00Z' }))).toMatchObject({ ok: true, event: { timeZone: 'America/Los_Angeles', startUtc: '2026-11-01T08:30:00.000Z' } });
  });
  it('isolates versions, rejects run reuse, reset affects only the selected run', async () => {
    const s = store(); const a = scope('old'); const b = { ...a, version: 'new' }; await s.create(a, calendarSeed(true)); await s.create(b, calendarSeed());
    await expect(s.create(a, calendarSeed())).rejects.toThrow();
    const sim = new CalendarSimulator(s); expect(await sim.execute(a, 'alice', call())).toMatchObject({ code: 'dependency_failure' });
    expect((await s.snapshot(a)).events).toHaveLength(1); expect(await sim.execute(b, 'alice', call())).toMatchObject({ code: 'created' });
    await s.reset(a); await s.reset(a); expect((await s.snapshot(b)).events).toHaveLength(2);
  });
});
it('SQL state graders catch false success and validate owner/time/permission baseline', async () => {
  const sim = new CalendarSimulator(new PostgresCalendarStore(db)); const sc = scope();
  const result = await runCalendarScenario({ simulator: sim, target: internalCalendarFixture('buggy', call()), scope: sc, scenarioId: 'dependency', actorId: 'alice', prompt: 'Book an interview', seed: calendarSeed(true) });
  expect(result.messages.at(-1)).toMatchObject({ content: 'Booked successfully.' });
  expect((await gradeCalendarState(db, sc, [{ kind: 'count', calendarId: 'personal', status: 'active', expected: 2 }])).passed).toBe(false);
  expect((await gradeCalendarState(db, sc, [{ kind: 'event', event: calendarSeed().events[0]! }, { kind: 'count', calendarId: 'restricted', status: 'active', expected: 0 }, { kind: 'no_overlap', calendarId: 'personal' }, { kind: 'successful_mutation', tool: 'create_event', expected: 0 }])).passed).toBe(true);
  const fixed = await reproduceCalendar({ simulator: sim, target: internalCalendarFixture('fixed', call()), scope: sc, scenarioId: 'dependency', actorId: 'alice', prompt: 'Book an interview', seed: calendarSeed(true) }, result);
  expect(fixed.reproduction.messages.at(-1)).toMatchObject({ content: 'Booking failed; no event was created.' });
  expect((await gradeSuccessClaim(db, result.scope, true, [{ kind: 'count', calendarId: 'personal', status: 'active', expected: 2 }])).falseSuccess).toBe(true);
  expect((await gradeSuccessClaim(db, fixed.reproduction.scope, false, [{ kind: 'count', calendarId: 'personal', status: 'active', expected: 2 }])).passed).toBe(true);
  expect(fixed.original).toEqual(result); expect(fixed.reproduction.scope.runId).not.toBe(result.scope.runId);
  expect(compareCalendar(result, fixed.reproduction).statisticalSignificance).toBe('not_assessed');
});
it('bounds tool rounds and rejects unknown tools and malformed arguments without mutation', async () => {
  const sim = new CalendarSimulator(new MemoryCalendarStore());
  const result = await runCalendarScenario({ simulator: sim, target: { complete: async () => ({ role: 'assistant', content: null, tool_calls: [call('unknown')] }) }, scope: scope(), scenarioId: 'loop', actorId: 'alice', prompt: 'Book', seed: calendarSeed() });
  expect(result.rounds).toBe(6); expect(result.stopped).toBe('round_limit'); expect(result.state.calls).toHaveLength(6); expect(result.state.events).toHaveLength(1);
  expect(await sim.execute(result.scope, 'alice', { ...call(), function: { name: 'create_event', arguments: '{' } })).toMatchObject({ code: 'invalid_arguments' });
});
it('updates a valid event, lists only authorized calendars, and rolls back callback failures', async () => {
  const s = new PostgresCalendarStore(db); const sc = scope(); await s.create(sc, calendarSeed()); const sim = new CalendarSimulator(s);
  const { calendarId: _, ...fields } = args;
  expect(await sim.execute(sc, 'alice', call('update_event', { ...fields, eventId: 'existing' }))).toMatchObject({ code: 'updated' });
  expect(await sim.execute(sc, 'alice', call('list_events', { calendarId: 'personal' }))).toMatchObject({ ok: true, events: [{ title: 'Interview' }] });
  expect(await sim.execute(sc, 'mallory', call('list_events', { calendarId: 'personal' }))).toMatchObject({ code: 'forbidden' });
  await expect(s.transact(sc, state => { state.events.length = 0; throw new Error('rollback'); })).rejects.toThrow('rollback');
  expect((await s.snapshot(sc)).events).toHaveLength(1);
});
it('SQL matching graders assess created fields without needing a generated ID; invalid/empty checks fail closed', async () => {
  const s = new PostgresCalendarStore(db); const sc = scope(); await s.create(sc, calendarSeed());
  await new CalendarSimulator(s).execute(sc, 'alice', call());
  const expected = { ...args, ownerId: 'alice', startUtc: new Date(args.startUtc).toISOString(), endUtc: new Date(args.endUtc).toISOString(), status: 'active' as const };
  expect((await gradeCalendarState(db, sc, [{ kind: 'matching_events', event: expected, expected: 1 }])).passed).toBe(true);
  expect((await gradeCalendarState(db, sc, [{ kind: 'matching_events', event: { ...expected, ownerId: 'bob' }, expected: 1 }])).passed).toBe(false);
  await expect(gradeCalendarState(db, sc, [])).rejects.toThrow();
});

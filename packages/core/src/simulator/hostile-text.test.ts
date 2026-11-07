import { readFile } from 'node:fs/promises';
import { it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { CalendarSimulator, calendarSeed, MemoryCalendarStore } from './calendar.js';
import { PostgresCalendarStore, type TransactionalDatabase } from './postgres.js';
import { runCalendarScenario } from './runner.js';
import type { ChatTarget } from '../targets/chat.js';

let pg: PGlite; let db: TransactionalDatabase;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(await readFile(new URL('./migrations/001_calendar.sql', import.meta.url), 'utf8'));
  db = { query: (s, p) => pg.query(s, p) as never, transaction: fn => pg.transaction(tx => fn({ query: (s, p) => tx.query(s, p) as never })) };
}, 30_000);
afterAll(async () => { await pg.close(); });

const base = { calendarId: 'personal', startUtc: '2026-11-09T19:00:00Z', endUtc: '2026-11-09T20:00:00Z', timeZone: 'UTC' };
const hostile: Array<[string, { id: string; args: string }]> = [
  ['NUL in title', { id: 'c1', args: JSON.stringify({ ...base, title: 'a\u0000b' }) }],
  ['lone surrogate in title (breaks jsonb result)', { id: 'c2', args: JSON.stringify({ ...base, title: 'a\ud800b' }) }],
  ['NUL in tool-call id', { id: 'c\u00003', args: JSON.stringify({ ...base, title: 'ok' }) }],
  ['NUL in raw arguments of an unknown tool', { id: 'c4', args: '{}\u0000' }],
];
for (const [label, h] of hostile) it(`target-controlled ${label} must yield a tool error, not an exception`, async () => {
  const store = new PostgresCalendarStore(db); const sim = new CalendarSimulator(store);
  const scope = { jobId: 'job', runId: crypto.randomUUID(), version: 'v1' };
  const target: ChatTarget = { async complete(messages) {
    if (messages.at(-1)?.role === 'tool') return { role: 'assistant', content: 'done' };
    return { role: 'assistant', content: null, tool_calls: [{ id: h.id, type: 'function', function: { name: label.includes('unknown') ? 'nope' : 'create_event', arguments: h.args } }] };
  } };
  // Hostile text must not escape as a database error or mutate calendar state.
  const run = await runCalendarScenario({ simulator: sim, target, scope, scenarioId: 's', actorId: 'alice', prompt: 'book', seed: calendarSeed() });
  expect(['complete', 'invalid_response']).toContain(run.stopped);
  expect(run.state.events).toHaveLength(1);
  if (run.stopped === 'invalid_response') expect(run.rejectedResponse).toBeDefined();
});
it('rejects unsafe direct tool calls consistently in memory and PostgreSQL', async () => {
  for (const store of [new MemoryCalendarStore(), new PostgresCalendarStore(db)]) {
    const scope = { jobId: 'job', runId: crypto.randomUUID(), version: 'v1' };
    await store.create(scope, calendarSeed());
    const sim = new CalendarSimulator(store);
    for (const [, h] of hostile) {
      expect(await sim.execute(scope, 'alice', { id: h.id, type: 'function', function: { name: 'create_event', arguments: h.args } })).toMatchObject({ ok: false, code: 'invalid_arguments' });
    }
    expect((await store.snapshot(scope)).events).toHaveLength(1);
  }
});
it('preserves partial transcript and safe stop reason on an unexpected simulator failure', async () => {
  const sim = new CalendarSimulator(new MemoryCalendarStore());
  sim.execute = async () => { throw new Error('sensitive database diagnostic'); };
  const target: ChatTarget = { complete: async () => ({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_event', arguments: JSON.stringify({ ...base, title: 'ok' }) } }] }) };
  const run = await runCalendarScenario({ simulator: sim, target, scope: { jobId: 'job', runId: crypto.randomUUID(), version: 'v1' }, scenarioId: 's', actorId: 'alice', prompt: 'book', seed: calendarSeed() });
  expect(run.stopped).toBe('simulator_error');
  expect(run.messages).toHaveLength(3);
  expect(JSON.stringify(run)).not.toContain('sensitive database diagnostic');
});

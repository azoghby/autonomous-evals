import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { calendarAcceptanceScenarios } from './acceptance-scenarios';
import { CalendarSimulator } from './calendar';
import { PostgresCalendarStore, type TransactionalDatabase } from './postgres';
import { gradeCalendarState } from './graders';

it('runs all twelve independent calendar acceptance cases against PostgreSQL', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(await readFile(new URL('./migrations/001_calendar.sql', import.meta.url), 'utf8'));
    const db: TransactionalDatabase = {
      query: (sql, params) => pg.query(sql, params),
      transaction: (fn) => pg.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params) })),
    };
    const store = new PostgresCalendarStore(db);
    const simulator = new CalendarSimulator(store);
    const scenarios = calendarAcceptanceScenarios();
    expect(scenarios).toHaveLength(12);
    expect(new Set(scenarios.map(s => s.id)).size).toBe(12);
    for (const scenario of scenarios) {
      const scope = { jobId: 'internal-acceptance', runId: scenario.id, version: 'reference' };
      await store.create(scope, scenario.seed);
      const codes: string[] = [];
      for (const call of scenario.referenceCalls) codes.push((await simulator.execute(scope, scenario.actorId, call)).code);
      expect(codes, scenario.id).toEqual(scenario.expectedToolCodes);
      expect((await gradeCalendarState(db, scope, scenario.checks)).passed, scenario.id).toBe(true);
    }
    expect(calendarAcceptanceScenarios()[0].seed.events).toHaveLength(1);
  } finally { await pg.close(); }
});

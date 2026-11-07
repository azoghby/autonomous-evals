import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { calendarAcceptanceScenarios } from '../acceptance-scenarios.js';
import { CalendarSimulator } from '../calendar.js';
import type { SqlPool } from '../pool.js';
import { PostgresCalendarStore, type TransactionalDatabase } from '../postgres.js';
import { freezeCalendarSuite, runCalendarSuite, investigateCalendarRun, type WorkflowInvestigationRecord } from './index.js';
import { PostgresWorkflowInvestigationJournal } from './postgres-journal.js';

// Bound PostgreSQL WASM startup on shared machines without relying on Vitest's 5s default.
const sqlTimeout = 30_000;
const tenant = 'tenant-1';
const key = 'calendar-investigation:job-1:run-1';
function record(): WorkflowInvestigationRecord {
  return {
    original: {
      jobId: 'job-1', branchId: 'branch-1', runId: 'run-1', suiteHash: 'a'.repeat(64),
      versionLabel: 'baseline', origin: 'internal_fixture',
      results: Array.from({ length: 12 }, (_, index) => ({
        scenarioId: `scenario-${index}`, scope: { jobId: 'job-1', runId: `scope-${index}`, version: 'baseline' },
        outcome: index < 4 ? 'product_failure' : 'passed', reason: index < 4 ? 'state_mismatch' : 'sql_checks_passed',
      })),
    }, attempts: [],
  };
}
function completed(value: WorkflowInvestigationRecord) {
  const next = structuredClone(value);
  next.attempts[0].result = { ...next.original.results[0], scope: { ...next.original.results[0].scope, runId: 'reproduction-1' } };
  return next;
}
async function database() {
  const db = new PGlite();
  await db.exec(await readFile(new URL('./persistence-migrations/001-workflow-investigation-journals.sql', import.meta.url), 'utf8'));
  const events: Array<{ sql: string; params?: unknown[] }> = [];
  // PGlite has one backend and no advisory lock functions. Only these functions
  // are intercepted; table statements/constraints/autocommit execute real SQL.
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    events.push({ sql, params });
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (sql.includes('pg_advisory_lock')) return { rows: [] };
    return db.query(sql, params);
  });
  const release = vi.fn();
  const pool: SqlPool = {
    query: vi.fn(async () => { throw new Error('unexpected unpinned query'); }),
    connect: vi.fn(async () => ({ query, release })),
  };
  return { db, query, pool, release, events, journal: new PostgresWorkflowInvestigationJournal(pool, tenant) };
}

async function read(s: Awaited<ReturnType<typeof database>>, journal = s.journal, journalKey = key) {
  return journal.withLock(journalKey, () => journal.load(journalKey));
}

describe('durable workflow journal SQL (PGlite; advisory functions intercepted)', () => {
  it('autocommits intent before returning save and recovers it after callback failure in a fresh adapter', async () => {
    const s = await database();
    try {
      const pending = record(); pending.attempts.push({ scenarioId: 'scenario-0' });
      await expect(s.journal.withLock(key, async () => {
        await s.journal.save(key, record());
        await s.journal.save(key, pending);
        const rows = await s.db.query<{ record: WorkflowInvestigationRecord }>('SELECT record FROM app_workflow_investigation_journals');
        expect(rows.rows[0].record).toEqual(pending);
        throw new Error('simulated process interruption');
      })).rejects.toThrow('simulated process interruption');
      expect(await read(s, new PostgresWorkflowInvestigationJournal(s.pool, tenant))).toEqual(pending);
      expect(s.events.some(({ sql }) => /^\s*(BEGIN|COMMIT|ROLLBACK)\b/.test(sql))).toBe(false);
      expect(s.pool.query).not.toHaveBeenCalled();
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it('keeps immutable originals and completed results, append-only attempts and the three-candidate budget', async () => {
    const s = await database();
    try {
      const initial = record();
      await s.journal.withLock(key, async () => {
        await s.journal.save(key, initial);
        initial.attempts.push({ scenarioId: 'scenario-0' });
        await s.journal.save(key, initial);
        await s.journal.save(key, completed(initial));
      });
      const saved = (await read(s))!;
      const mutations: WorkflowInvestigationRecord[] = [];
      const changedOriginal = structuredClone(saved); changedOriginal.original.branchId = 'other'; mutations.push(changedOriginal);
      const removed = structuredClone(saved); removed.attempts = []; mutations.push(removed);
      const reset = structuredClone(saved); delete reset.attempts[0].result; mutations.push(reset);
      const changedResult = structuredClone(saved); changedResult.attempts[0].result!.reason = 'changed'; mutations.push(changedResult);
      const duplicate = structuredClone(saved); duplicate.attempts.push({ scenarioId: 'scenario-0' }); mutations.push(duplicate);
      const fourthCandidate = structuredClone(saved); fourthCandidate.attempts.push({ scenarioId: 'scenario-3' }); mutations.push(fourthCandidate);
      const passing = structuredClone(saved); passing.attempts.push({ scenarioId: 'scenario-4' }); mutations.push(passing);
      const overBudget = structuredClone(saved); overBudget.attempts.push(...['scenario-1', 'scenario-2', 'scenario-3'].map(scenarioId => ({ scenarioId }))); mutations.push(overBudget);
      for (const mutation of mutations) {
        await expect(s.journal.withLock(key, () => s.journal.save(key, mutation))).rejects.toThrow(/^workflow_journal_/);
        expect(await read(s)).toEqual(saved);
      }
      await s.journal.withLock(key, () => s.journal.save(key, saved)); // Identical replay is harmless.
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it('accepts exactly three sequential pending intents and retains all of them across reloads', async () => {
    const s = await database();
    try {
      const value = record();
      await s.journal.withLock(key, async () => {
        await s.journal.save(key, value);
        for (const scenarioId of ['scenario-0', 'scenario-1', 'scenario-2']) {
          value.attempts.push({ scenarioId }); await s.journal.save(key, value);
        }
      });
      expect(await read(s)).toEqual(value);
      const extra = structuredClone(value); extra.attempts.push({ scenarioId: 'scenario-3' });
      await expect(s.journal.withLock(key, () => s.journal.save(key, extra))).rejects.toThrow(/^workflow_journal_/);
      expect(await read(s)).toEqual(value);
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it('rejects a stale compare-and-swap write instead of overwriting an out-of-band update', async () => {
    const s = await database();
    try {
      await s.journal.withLock(key, () => s.journal.save(key, record()));
      const newer = record(); newer.original.systemPrompt = 'out-of-band imported identity';
      const original = s.query.getMockImplementation()!;
      let injected = false;
      s.query.mockImplementation(async (sql, params) => {
        if (!injected && /^\s*INSERT\b/.test(sql)) {
          injected = true;
          await s.db.query('UPDATE app_workflow_investigation_journals SET record=$1::jsonb WHERE tenant_id=$2 AND journal_key=$3', [JSON.stringify(newer), tenant, key]);
        }
        return original(sql, params);
      });
      const next = record(); next.attempts.push({ scenarioId: 'scenario-0' });
      await expect(s.journal.withLock(key, () => s.journal.save(key, next))).rejects.toThrow('workflow_journal_transition_conflict');
      expect(injected).toBe(true);
      expect(await read(s)).toEqual(newer);
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it('rejects adding completed work without first durably recording its pending intent', async () => {
    const s = await database();
    try {
      const pending = record(); pending.attempts.push({ scenarioId: 'scenario-0' });
      await s.journal.withLock(key, () => s.journal.save(key, record()));
      await expect(s.journal.withLock(key, () => s.journal.save(key, completed(pending)))).rejects.toThrow(/^workflow_journal_/);
      expect((await read(s))?.attempts).toEqual([]);
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it('isolates tenants and uses tuple-safe lock identity for delimiter-bearing tenant/key pairs', async () => {
    const s = await database();
    try {
      const a = new PostgresWorkflowInvestigationJournal(s.pool, 'tenant:a');
      const b = new PostgresWorkflowInvestigationJournal(s.pool, 'tenant');
      const first = record(); const second = record(); second.original.systemPrompt = 'second tenant';
      await a.withLock('b', () => a.save('b', first));
      await b.withLock('a:b', () => b.save('a:b', second));
      expect(await a.withLock('b', () => a.load('b'))).toEqual(first);
      expect(await b.withLock('a:b', () => b.load('a:b'))).toEqual(second);
      const locks = s.events.filter(({ sql }) => sql.includes('pg_advisory_lock')).map(({ params }) => params?.[0]);
      expect(locks[0]).not.toEqual(locks[1]);
      expect((await s.db.query('SELECT * FROM app_workflow_investigation_journals')).rows).toHaveLength(2);
      const sameKeyOtherTenant = new PostgresWorkflowInvestigationJournal(s.pool, 'another-tenant');
      expect(await sameKeyOtherTenant.withLock('b', () => sameKeyOtherTenant.load('b'))).toBeUndefined();
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it.each(['\u0000', '\ud800', '\udfff'])('rejects non-PostgreSQL JSON text %j before a write', async bad => {
    const s = await database();
    try {
      const invalid = record(); invalid.original.systemPrompt = `private${bad}`;
      await expect(s.journal.withLock(key, () => s.journal.save(key, invalid))).rejects.toThrow(/^workflow_journal_/);
      expect(s.events.some(({ sql }) => /^\s*INSERT\b/.test(sql))).toBe(false);
      await expect(s.journal.withLock(bad, async () => undefined)).rejects.toThrow(/^workflow_journal_/);
      expect(() => new PostgresWorkflowInvestigationJournal(s.pool, bad)).toThrow(/^workflow_journal_/);
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it('rejects invalid JSON object keys and non-JSON values before driver dispatch', async () => {
    const s = await database();
    try {
      const invalid: unknown[] = [
        { ...record(), ['bad\u0000key']: 'value' }, { ...record(), ['bad\ud800key']: 'value' },
        { ...record(), extra: Number.NaN }, { ...record(), extra: 1n },
      ];
      const cycle = record() as WorkflowInvestigationRecord & { self?: unknown }; cycle.self = cycle; invalid.push(cycle);
      for (const value of invalid) {
        await expect(s.journal.withLock(key, () => s.journal.save(key, value as WorkflowInvestigationRecord))).rejects.toThrow(/^workflow_journal_/);
      }
      expect(s.events.some(({ sql }) => /^\s*INSERT\b/.test(sql))).toBe(false);
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it('accepts paired supplementary Unicode and returns detached loaded values', async () => {
    const s = await database();
    try {
      const input = record(); input.original.systemPrompt = 'calendar 📅';
      await s.journal.withLock(key, () => s.journal.save(key, input));
      input.original.systemPrompt = 'mutated caller';
      const loaded = (await read(s))!; expect(loaded.original.systemPrompt).toBe('calendar 📅');
      loaded.original.systemPrompt = 'mutated read';
      expect((await read(s))?.original.systemPrompt).toBe('calendar 📅');
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it('validates imported JSON records, outcome/scope relationships and reproduction eligibility', async () => {
    const s = await database();
    try {
      const badScope = record(); badScope.original.results[0].scope.jobId = 'other-job';
      const duplicate = record(); duplicate.original.results[1].scenarioId = duplicate.original.results[0].scenarioId;
      const badAttempt = record(); badAttempt.attempts.push({ scenarioId: 'scenario-4' });
      const wrongResult = record(); wrongResult.attempts.push({ scenarioId: 'scenario-0', result: { ...wrongResult.original.results[1] } });
      for (const value of [null, {}, { ...record(), secret: 'unknown field' }, badScope, duplicate, badAttempt, wrongResult]) {
        // Import bypasses the public adapter. Loads must still distrust JSONB.
        await s.db.query('DELETE FROM app_workflow_investigation_journals');
        try {
          await s.db.query('INSERT INTO app_workflow_investigation_journals (tenant_id,journal_key,record) VALUES ($1,$2,$3::jsonb)', [tenant, key, JSON.stringify(value)]);
        } catch { continue; } // A SQL constraint rejecting malformed imports is also valid.
        await expect(read(s)).rejects.toThrow(/^workflow_journal_/);
      }
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it('round-trips complete simulator evidence and persists at most three completed reproductions', async () => {
    const s = await database();
    try {
      await s.db.exec(await readFile(new URL('../migrations/001_calendar.sql', import.meta.url), 'utf8'));
      const acceptance = calendarAcceptanceScenarios();
      const suite = freezeCalendarSuite({ jobId: 'job-1', origin: 'internal_fixture', frozenAt: '2026-11-07T20:00:00.000Z',
        review: { reviewerId: 'reviewer', approved: true }, scenarios: acceptance.map(({ id, prompt, actorId, seed, checks }) => ({ id, prompt, actorId, seed, checks })) });
      const db: TransactionalDatabase = { query: (sql, params) => s.db.query(sql, params),
        transaction: action => s.db.transaction(tx => action({ query: (sql, params) => tx.query(sql, params) })) };
      const targetForScenario = vi.fn((scenario: { id: string }) => ({ complete: async (messages: Array<{ role: string }>) => messages.some(m => m.role === 'tool')
        ? { role: 'assistant' as const, content: 'Reference complete.' }
        : { role: 'assistant' as const, content: null, tool_calls: structuredClone(acceptance.find(a => a.id === scenario.id)!.referenceCalls) } }));
      const dependencies = { simulator: new CalendarSimulator(new PostgresCalendarStore(db)), db, targetForScenario };
      const original = await runCalendarSuite({ suite, versionLabel: 'baseline', branchId: 'branch-1', dependencies });
      // Synthetic original verdicts create four candidates while retaining full real execution evidence.
      const candidateRun = structuredClone(original);
      candidateRun.results.slice(0, 4).forEach(result => { result.outcome = 'product_failure'; result.reason = 'state_mismatch'; });
      targetForScenario.mockClear();
      const output = await investigateCalendarRun({ suite, run: candidateRun, dependencies, journal: s.journal });
      expect(output.reproductions).toHaveLength(3); expect(output.pendingScenarioIds).toEqual([]);
      expect(targetForScenario).toHaveBeenCalledTimes(3);
      const actualKey = `calendar-investigation:${candidateRun.jobId}:${candidateRun.runId}`;
      const loaded = (await read(s, new PostgresWorkflowInvestigationJournal(s.pool, tenant), actualKey))!;
      expect(loaded.original).toEqual(candidateRun); expect(loaded.attempts).toHaveLength(3);
      expect(loaded.attempts.every(a => a.result?.execution && a.result.stateGrade?.passed)).toBe(true);
      const mismatched = structuredClone(loaded); mismatched.original.results[0].execution!.scope.runId = 'wrong-execution-scope';
      await s.db.query('UPDATE app_workflow_investigation_journals SET record=$1::jsonb WHERE tenant_id=$2 AND journal_key=$3', [JSON.stringify(mismatched), tenant, actualKey]);
      await expect(read(s, s.journal, actualKey)).rejects.toThrow('workflow_journal_invalid_record');
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it('persists intent before actual workflow dispatch and never redispatches recovered ambiguous work', async () => {
    const s = await database();
    try {
      const suite = freezeCalendarSuite({ jobId: 'job-1', origin: 'internal_fixture', frozenAt: '2026-11-07T20:00:00.000Z',
        review: { reviewerId: 'reviewer', approved: true }, scenarios: calendarAcceptanceScenarios().map(({ id, prompt, actorId, seed, checks }) => ({ id, prompt, actorId, seed, checks })) });
      const original = record().original; original.suiteHash = suite.hash;
      original.results = suite.scenarios.map((scenario, index) => ({ scenarioId: scenario.id, scope: { jobId: original.jobId, runId: `scope-${index}`, version: original.versionLabel }, outcome: index === 0 ? 'product_failure' : 'passed', reason: index === 0 ? 'state_mismatch' : 'sql_checks_passed' }));
      const dispatch = vi.fn(async () => {
        const stored = await s.db.query<{ record: WorkflowInvestigationRecord }>('SELECT record FROM app_workflow_investigation_journals');
        expect(stored.rows[0].record.attempts).toEqual([{ scenarioId: suite.scenarios[0].id }]);
        throw new Error('ambiguous external failure');
      });
      const dependencies = { simulator: { store: { snapshot: async () => { throw new Error('unavailable'); } } } as unknown as CalendarSimulator,
        db: { query: async () => ({ rows: [] }), transaction: async () => { throw new Error('unavailable'); } }, targetForScenario: dispatch };
      const interrupted = { withLock: s.journal.withLock.bind(s.journal), load: s.journal.load.bind(s.journal), save: async (journalKey: string, value: WorkflowInvestigationRecord) => {
        if (value.attempts.some(attempt => attempt.result)) throw new Error('completion not saved');
        await s.journal.save(journalKey, value);
      } };
      await expect(investigateCalendarRun({ suite, run: original, dependencies, journal: interrupted })).rejects.toThrow('completion not saved');
      const fresh = new PostgresWorkflowInvestigationJournal(s.pool, tenant);
      const recovered = await investigateCalendarRun({ suite, run: original, dependencies, journal: fresh });
      expect(recovered.pendingScenarioIds).toEqual([suite.scenarios[0].id]);
      expect(recovered.reproductions).toEqual([]);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { await s.db.close(); }
  }, sqlTimeout);
});

describe('pinned journal session lifetime and safe SQL failures', () => {
  it('requires the active same-key scope and rejects escaped asynchronous work after release', async () => {
    const s = await database();
    try {
      await expect(s.journal.load(key)).rejects.toThrow(/^workflow_journal_/);
      await expect(s.journal.save(key, record())).rejects.toThrow(/^workflow_journal_/);
      let resume!: () => void; const gate = new Promise<void>(resolve => { resume = resolve; });
      let escaped!: Promise<unknown>;
      await s.journal.withLock(key, async () => {
        await expect(s.journal.load('other')).rejects.toThrow(/^workflow_journal_/);
        escaped = gate.then(() => s.journal.save(key, record()));
      });
      resume(); await expect(escaped).rejects.toThrow(/^workflow_journal_/);
      expect(s.release).toHaveBeenCalledWith(undefined);
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it('waits for an autocommit before resolving save or releasing its session, including unawaited saves', async () => {
    const s = await database();
    try {
      const original = s.query.getMockImplementation()!;
      let entered!: () => void; const writing = new Promise<void>(resolve => { entered = resolve; });
      let commit!: () => void; const committed = new Promise<void>(resolve => { commit = resolve; });
      s.query.mockImplementation(async (sql, params) => {
        if (/^\s*INSERT\b/.test(sql)) { entered(); await committed; }
        return original(sql, params);
      });
      let resolved = false;
      const operation = s.journal.withLock(key, async () => { void s.journal.save(key, record()).then(() => { resolved = true; }); });
      await writing;
      expect(resolved).toBe(false); expect(s.release).not.toHaveBeenCalled();
      expect(s.events.some(({ sql }) => sql.includes('pg_advisory_unlock'))).toBe(false);
      commit(); await operation;
      expect(resolved).toBe(true); expect(s.release).toHaveBeenCalledWith(undefined);
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it.each(['lock', 'load', 'save', 'unlock', 'false-unlock'])('sanitizes %s failures and discards the session', async stage => {
    const s = await database();
    try {
      const original = s.query.getMockImplementation()!;
      s.query.mockImplementation(async (sql, params) => {
        if ((stage === 'lock' && sql.includes('pg_advisory_lock')) || (stage === 'load' && sql.includes('FROM app_workflow_investigation_journals') && /^\s*SELECT\b/.test(sql)) ||
            (stage === 'save' && /^\s*INSERT\b/.test(sql)) || (stage === 'unlock' && sql.includes('pg_advisory_unlock'))) throw new Error('postgres://private:secret@database');
        if (stage === 'false-unlock' && sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: false }] };
        return original(sql, params);
      });
      await expect(s.journal.withLock(key, async () => { await s.journal.load(key); await s.journal.save(key, record()); })).rejects.toThrow(/^workflow_journal_/);
      expect(s.release).toHaveBeenCalledWith(expect.any(Error));
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it('does not report success when callback catches a failed write, and never retries its callback', async () => {
    const s = await database();
    try {
      const original = s.query.getMockImplementation()!;
      s.query.mockImplementation(async (sql, params) => {
        if (/^\s*INSERT\b/.test(sql)) throw new Error('secret SQL failure');
        return original(sql, params);
      });
      const callback = vi.fn(async () => { await s.journal.save(key, record()).catch(() => undefined); return 'success'; });
      await expect(s.journal.withLock(key, callback)).rejects.toThrow(/^workflow_journal_/);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(s.release).toHaveBeenCalledWith(expect.any(Error));
    } finally { await s.db.close(); }
  }, sqlTimeout);

  it('sanitizes connection/release failures and preserves the original callback error', async () => {
    // No table statement participates in this test: exercise pool lifetime directly.
    const release = vi.fn((_error?: Error) => {});
    const pool: SqlPool = {
      query: async () => { throw new Error('unexpected pool query'); },
      connect: async () => ({ release, query: async sql => ({ rows: sql.includes('pg_advisory_unlock') ? [{ unlocked: true }] : [] }) }),
    };
    const journal = new PostgresWorkflowInvestigationJournal(pool, tenant);
    const failingPool: SqlPool = { query: pool.query, connect: async () => { throw new Error('private connection'); } };
    await expect(new PostgresWorkflowInvestigationJournal(failingPool, tenant).withLock(key, async () => 1)).rejects.toThrow(/^workflow_journal_/);
    release.mockImplementationOnce(() => { throw new Error('private release'); });
    await expect(journal.withLock(key, async () => { throw new Error('callback failure'); })).rejects.toThrow('callback failure');
    expect(release).toHaveBeenLastCalledWith(expect.any(Error));
    release.mockImplementationOnce(() => { throw new Error('private release'); });
    await expect(journal.withLock(key, async () => 1)).rejects.toThrow(/^workflow_journal_/);
  }, sqlTimeout);
});

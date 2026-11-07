import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../src/contracts/services';
import type { AgentTransactionalSql } from '../../src/agents/postgres-ports';
import type { JobRef } from '../../src/evals/types';
import { PostgresTextCheckpointStore, type TextCheckpointStore } from '../../src/evals/integration/checkpoints';
import { calendarAcceptanceScenarios } from '../../src/simulator/acceptance-scenarios';
import { CalendarSimulator } from '../../src/simulator/calendar';
import { PostgresCalendarStore } from '../../src/simulator/postgres';
import type { SqlPool } from '../../src/simulator/pool';
import type { ChatTarget } from '../../src/targets/chat';
import type { CalendarSuiteInput } from '../../src/simulator/workflow';
import { createCalendarEvaluationServices } from '../../src/evals/calendar-integration';
import { renderCalendarReport } from '../../src/reporting/calendar';

const request = { suiteId: 'reviewed-suite', operationId: 'workflow-baseline', versionLabel: 'baseline' };
const acceptance = calendarAcceptanceScenarios();

describe('independent service boundary review (PGlite, advisory locks intercepted)', () => {
  let engine: PGlite;
  let db: AgentTransactionalSql;
  let pool: SqlPool;
  beforeAll(async () => {
    engine = new PGlite();
    for (const path of [
      '../../src/simulator/migrations/001_calendar.sql',
      '../../src/simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql',
      '../../src/evals/integration/migrations/001-text-integration.sql',
    ]) await engine.exec(readFileSync(new URL(path, import.meta.url), 'utf8'));
    db = {
      query: <T>(sql: string, params?: unknown[]) => engine.query<T>(sql, params),
      transaction: fn => engine.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })),
    };
    // PGlite has one backend. Only advisory functions are intercepted; all table
    // SQL, simulator transactions, journal CAS and checkpoints execute unchanged.
    // This fixture does NOT prove native PostgreSQL multi-session locking.
    pool = {
      query: (sql, params) => engine.query(sql, params),
      connect: async () => ({
        query: async (sql, params) => sql.includes('pg_advisory_unlock') ? { rows: [{ unlocked: true }] }
          : sql.includes('pg_advisory_lock') ? { rows: [] } : engine.query(sql, params),
        release: () => {},
      }),
    };
  }, 30_000);
  afterAll(async () => { await engine.close(); });

  function setup(options: { target?: ChatTarget; checkpoints?: TextCheckpointStore; reference?: boolean; secret?: string } = {}) {
    const job: JobRef = { jobId: randomUUID(), customerId: 'local-calendar-fixture', package: 'workflow_eval', environment: 'test', quoteVersion: null, linkedRetestOf: null, isFixture: true };
    const ctx: ServiceContext = { jobId: job.jobId, environment: 'test', budgetMicroUsd: 0, recordCost: vi.fn(async () => {}), recordProgress: vi.fn(async () => {}) };
    const reviewedSuite: CalendarSuiteInput = {
      jobId: job.jobId, origin: 'internal_fixture' as const, frozenAt: '2026-11-07T20:00:00.000Z',
      review: { reviewerId: 'trusted-fixture-reviewer', approved: true as const },
      scenarios: acceptance.map(({ id, prompt, actorId, seed, checks }) => structuredClone({ id, prompt, actorId, seed, checks })),
    };
    const complete = vi.fn<ChatTarget['complete']>(async messages => {
      if (options.target) return options.target.complete(messages);
      return { role: 'assistant', content: 'No action was performed.' };
    });
    const targetForScenario = vi.fn((scenario: { id: string }) => {
      if (!options.reference) return { complete };
      return { complete: vi.fn<ChatTarget['complete']>(async messages => {
        await complete(messages);
        return messages.some(m => m.role === 'tool') ? { role: 'assistant', content: 'Reference sequence complete.' }
          : { role: 'assistant', content: null, tool_calls: structuredClone(acceptance.find(s => s.id === scenario.id)!.referenceCalls) };
      }) };
    });
    const resolved = {
      job, branch: { jobId: job.jobId, branchId: 'authorized-branch', targetVersion: 'target-config-v1' }, targetVersion: 'target-config-v1',
      dependencies: { db, simulator: new CalendarSimulator(new PostgresCalendarStore(db)), targetForScenario },
      reviewedSuite, systemPrompt: 'Trusted calendar system prompt.', knownSecrets: options.secret ? [options.secret] : [],
    };
    const resolve = vi.fn(async () => resolved);
    const checkpoints = options.checkpoints ?? new PostgresTextCheckpointStore(db);
    const restart = () => createCalendarEvaluationServices({ checkpoints: options.checkpoints ?? new PostgresTextCheckpointStore(db), journalPool: pool, resolve });
    return { api: restart(), restart, ctx, job, resolved, resolve, complete, targetForScenario, checkpoints };
  }

  it('retains full failing run, original, reproduction and report after fresh adapters without any redispatch', async () => {
    const f = setup();
    const suite = await f.api.freezeSuite(f.ctx, request);
    const run = await f.restart().runSuite(f.ctx, request);
    const investigation = await f.restart().investigate(f.ctx, request);
    expect(investigation.reproductions).toHaveLength(3);
    expect(investigation.original).toEqual(run);
    expect(investigation.findings.filter(x => x.status === 'confirmed')).toHaveLength(3);
    const calls = f.complete.mock.calls.length;
    expect(await f.restart().getSuite(f.ctx, request)).toEqual(suite);
    expect(await f.restart().runSuite(f.ctx, request)).toEqual(run);
    expect(await f.restart().investigate(f.ctx, request)).toEqual(investigation);
    const report = await f.restart().reportInput(f.ctx, request);
    expect(report).toMatchObject({ suite, run, investigation, findings: investigation.findings });
    const rendered = renderCalendarReport({ job: f.job, report, generatedAt: suite.frozenAt, costs: null });
    expect(rendered.json.details.calendar).toMatchObject({ suite, run, investigation });
    // Complete transcript, scope, checks and state survive JSON persistence, not just excerpts.
    expect(run.results.every(x => x.execution?.messages.length && x.stateGrade?.results.length)).toBe(true);
    expect(f.complete).toHaveBeenCalledTimes(calls);
  });

  it('rejects customer/environment/branch/target/prompt/review/version/suite drift at completed replay', async () => {
    const f = setup();
    await f.api.freezeSuite(f.ctx, request);
    await f.api.runSuite(f.ctx, request);
    const initial = structuredClone({ job: f.resolved.job, branch: f.resolved.branch, targetVersion: f.resolved.targetVersion,
      systemPrompt: f.resolved.systemPrompt, reviewedSuite: f.resolved.reviewedSuite });
    const mutations = [
      () => { f.resolved.job.customerId = 'different-authorized-customer'; },
      () => { f.resolved.branch.branchId = 'new-branch'; },
      () => { f.resolved.targetVersion = f.resolved.branch.targetVersion = 'config-v2'; },
      () => { f.resolved.systemPrompt = 'new prompt'; },
      () => { f.resolved.reviewedSuite.frozenAt = '2026-11-08T20:00:00.000Z'; },
    ];
    for (const change of mutations) {
      change();
      await expect(f.restart().runSuite(f.ctx, request)).rejects.toThrow();
      Object.assign(f.resolved, structuredClone(initial));
    }
    await expect(f.restart().runSuite({ ...f.ctx, environment: 'live' }, request)).rejects.toThrow();
    await expect(f.restart().runSuite(f.ctx, { ...request, versionLabel: 'changed' })).rejects.toThrow();
    await f.api.freezeSuite(f.ctx, { suiteId: 'second-suite' });
    await expect(f.restart().runSuite(f.ctx, { ...request, suiteId: 'second-suite' })).rejects.toThrow();
    expect(f.complete).toHaveBeenCalledTimes(12);
  });

  it('re-resolves reads, replay and reports; authorization withdrawal exposes no saved evidence', async () => {
    const f = setup();
    await f.api.freezeSuite(f.ctx, request);
    await f.api.runSuite(f.ctx, request);
    await f.api.investigate(f.ctx, request);
    const count = f.complete.mock.calls.length;
    f.resolve.mockRejectedValue(new Error('credential-laden resolver exception'));
    for (const method of ['freezeSuite', 'getSuite', 'runSuite', 'investigate', 'reportInput'] as const) {
      await expect(f.restart()[method](f.ctx, request)).rejects.toMatchObject({ code: 'rejected_input' });
    }
    expect(f.complete).toHaveBeenCalledTimes(count);
  });

  it('claims before dispatch; pending competing callers get no right to retry', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = setup({ target: { async complete() { entered(); await gate; return { role: 'assistant', content: 'No action.' }; } } });
    await f.api.freezeSuite(f.ctx, request);
    const running = f.api.runSuite(f.ctx, request);
    await started;
    try {
      expect(await f.checkpoints.get({ jobId: f.job.jobId, kind: 'calendar_run', id: request.operationId })).toEqual({ state: 'pending' });
      await expect(f.restart().runSuite(f.ctx, request)).rejects.toMatchObject({ name: 'TrackBPendingError' });
    } finally { release(); }
    const run = await running;
    expect(await f.restart().runSuite(f.ctx, request)).toEqual(run);
    expect(f.complete).toHaveBeenCalledTimes(12);
  });

  it('lost committed claim acknowledgement prevents all target dispatch across fresh services', async () => {
    const real = new PostgresTextCheckpointStore(db);
    let lose = true;
    const checkpoints: TextCheckpointStore = { ...{
      get: real.get.bind(real), complete: real.complete.bind(real), release: real.release.bind(real), markAmbiguous: real.markAmbiguous.bind(real),
    }, async claim(k) { const claim = await real.claim(k); if (k.kind === 'calendar_run' && lose) { lose = false; throw new Error('ack lost'); } return claim; } };
    const f = setup({ checkpoints });
    await f.api.freezeSuite(f.ctx, request);
    await expect(f.api.runSuite(f.ctx, request)).rejects.toMatchObject({ code: 'needs_operator' });
    await expect(f.restart().runSuite(f.ctx, request)).rejects.toMatchObject({ name: 'TrackBPendingError' });
    expect(f.complete).not.toHaveBeenCalled();
    expect(await real.get({ jobId: f.job.jobId, kind: 'calendar_run', id: request.operationId })).toEqual({ state: 'pending' });
  });

  it.each([false, true])('lost investigation completion acknowledgement (committed=%s) retains journal and fences or replays', async committed => {
    const real = new PostgresTextCheckpointStore(db);
    let lose = true;
    const checkpoints: TextCheckpointStore = {
      claim: real.claim.bind(real), get: real.get.bind(real), release: real.release.bind(real), markAmbiguous: real.markAmbiguous.bind(real),
      async complete(k, token, value) {
        if (k.kind === 'calendar_investigation' && lose) {
          lose = false;
          if (committed) await real.complete(k, token, value);
          throw new Error('completion ack lost');
        }
        await real.complete(k, token, value);
      },
    };
    const f = setup({ checkpoints });
    await f.api.freezeSuite(f.ctx, request);
    const run = await f.api.runSuite(f.ctx, request);
    await expect(f.api.investigate(f.ctx, request)).rejects.toMatchObject({ code: 'needs_operator' });
    const calls = f.complete.mock.calls.length;
    const rows = await engine.query<{ record: { original: typeof run; attempts: Array<{ result?: unknown }> } }>('SELECT record FROM app_workflow_investigation_journals');
    const record = rows.rows.find(r => r.record.original.runId === run.runId)?.record;
    expect(record?.original).toEqual(run);
    expect(record?.attempts).toHaveLength(3);
    expect(record?.attempts.every(x => x.result)).toBe(true);
    if (committed) {
      const investigation = await f.restart().investigate(f.ctx, request);
      expect((await f.restart().reportInput(f.ctx, request)).investigation).toEqual(investigation);
    } else {
      await expect(f.restart().investigate(f.ctx, request)).rejects.toMatchObject({ code: 'needs_operator' });
      await expect(f.restart().reportInput(f.ctx, request)).rejects.toMatchObject({ code: 'needs_operator' });
    }
    expect(f.complete).toHaveBeenCalledTimes(calls);
  });

  it('CHARACTERIZATION: invalid version consumes operation ID before any target call, preventing corrected request', async () => {
    const f = setup();
    await f.api.freezeSuite(f.ctx, request);
    await expect(f.api.runSuite(f.ctx, { ...request, versionLabel: '' })).rejects.toMatchObject({ code: 'needs_operator' });
    const key = { jobId: f.job.jobId, kind: 'calendar_run', id: request.operationId };
    expect(await f.checkpoints.get(key)).toEqual({ state: 'ambiguous' });
    await expect(f.restart().runSuite(f.ctx, request)).rejects.toMatchObject({ code: 'needs_operator' });
    expect(f.complete).not.toHaveBeenCalled();
  });
});

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServiceContext } from '../../contracts/services';
import type { AgentTransactionalSql } from '../../agents/postgres-ports';
import type { JobRef } from '../types';
import { PostgresTextCheckpointStore, type TextCheckpointStore } from '../integration/checkpoints';
import { calendarAcceptanceScenarios } from '../../simulator/acceptance-scenarios';
import { CalendarSimulator } from '../../simulator/calendar';
import { PostgresCalendarStore } from '../../simulator/postgres';
import type { SqlPool } from '../../simulator/pool';
import type { ChatTarget } from '../../targets/chat';
import type { CalendarSuiteInput } from '../../simulator/workflow';
import { createCalendarEvaluationServices } from './index';
import { renderCalendarReport } from '../../reporting/calendar';

const request = { suiteId: 'reviewed-suite', operationId: 'workflow-baseline', versionLabel: 'baseline' };
const acceptance = calendarAcceptanceScenarios();

describe('durable calendar integration: SQL-backed local fixtures', () => {
  let engine: PGlite;
  let db: AgentTransactionalSql;
  let pool: SqlPool;
  beforeAll(async () => {
    engine = new PGlite();
    for (const path of [
      '../../simulator/migrations/001_calendar.sql',
      '../../simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql',
      '../integration/migrations/001-text-integration.sql',
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
    const restart = () => createCalendarEvaluationServices({ checkpoints, journalPool: pool, resolve });
    return { api: restart(), restart, ctx, job, resolved, resolve, complete, targetForScenario, checkpoints };
  }

  it('freezes trusted reviewed input and replays a full SQL-graded reference Workflow after fresh service construction', async () => {
    const f = setup({ reference: true });
    const suite = await f.api.freezeSuite(f.ctx, request);
    expect(suite.scenarios).toHaveLength(12);
    expect(await f.restart().getSuite(f.ctx, request)).toEqual(suite);
    const run = await f.api.runSuite(f.ctx, request);
    expect(run.results.map(r => r.outcome)).toEqual(Array(12).fill('passed'));
    expect(f.complete).toHaveBeenCalledTimes(24);
    for (const result of run.results) {
      expect(await f.resolved.dependencies.simulator.store.snapshot(result.scope)).toEqual(result.execution!.state);
      expect(result.stateGrade?.passed).toBe(true);
    }
    const restarted = f.restart();
    expect(await restarted.runSuite(f.ctx, request)).toEqual(run);
    const investigation = await restarted.investigate(f.ctx, request);
    expect(investigation.findings).toEqual([]);
    expect(await f.restart().investigate(f.ctx, request)).toEqual(investigation);
    const report = await f.restart().reportInput(f.ctx, request);
    expect(report.run).toEqual(run);
    expect(report.suite).toEqual(suite);
    const rendered = renderCalendarReport({ job: f.job, report, generatedAt: suite.frozenAt, costs: null, includeHtml: true });
    expect(rendered.json.evaluationStatus).toBe('completed');
    expect(rendered.json.details.calendar).toMatchObject({ run, investigation });
    expect(rendered.json.costs.knownMicroUsd).toBeNull();
    expect(() => renderCalendarReport({ job: { ...f.job, jobId: 'other-job' }, report, generatedAt: suite.frozenAt, costs: null })).toThrow('identity_mismatch');
    expect(f.complete).toHaveBeenCalledTimes(24);
    expect(f.resolve).toHaveBeenCalledTimes(7);
    expect(JSON.stringify(await engine.query('SELECT value FROM text_integration.checkpoints WHERE job_id=$1', [f.job.jobId]))).not.toContain('postgres://');
  });

  it('persists complete original and bounded reproduction evidence through the Postgres journal and replays findings', async () => {
    const f = setup();
    await f.api.freezeSuite(f.ctx, request);
    const run = await f.api.runSuite(f.ctx, request);
    expect(run.results.some(r => r.outcome === 'product_failure')).toBe(true);
    const investigation = await f.api.investigate(f.ctx, request);
    expect(investigation.reproductions).toHaveLength(3);
    expect(investigation.pendingScenarioIds).toEqual([]);
    expect(investigation.findings.filter(r => r.status === 'confirmed')).toHaveLength(3);
    const calls = f.complete.mock.calls.length;
    expect(await f.restart().investigate(f.ctx, request)).toEqual(investigation);
    expect(f.complete).toHaveBeenCalledTimes(calls);
    const rows = await engine.query<{ record: { original: unknown; attempts: unknown[] } }>('SELECT record FROM app_workflow_investigation_journals');
    const row = rows.rows.find(r => JSON.stringify(r.record.original).includes(run.runId));
    expect(row?.record.original).toEqual(JSON.parse(JSON.stringify(run)));
    expect(row?.record.attempts).toHaveLength(3);
    expect(JSON.stringify(investigation)).toContain('No action was performed.');
    const report = await f.api.reportInput(f.ctx, request);
    const rendered = renderCalendarReport({ job: f.job, report, generatedAt: report.suite.frozenAt, costs: null });
    expect(rendered.json.findings.filter(f => f.label === 'confirmed')).toHaveLength(3);
    expect(rendered.json.findings.every(f => f.source === 'workflow_eval')).toBe(true);
    expect(rendered.json.findings.filter(f => f.label === 'confirmed').every(f => f.reproduction?.attempted)).toBe(true);
    expect(rendered.json.details.calendar).toMatchObject({ investigation });
  });

  it('serializes competing Workflow run claims before dispatch without redispatch', async () => {
    let unblock!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let first = true;
    const f = setup({ target: { async complete() {
      if (first) { first = false; entered(); await gate; }
      return { role: 'assistant', content: 'No action was performed.' };
    } } });
    await f.api.freezeSuite(f.ctx, request);
    const running = f.api.runSuite(f.ctx, request);
    await started;
    try { await expect(f.restart().runSuite(f.ctx, request)).rejects.toThrow(); }
    finally { unblock(); }
    const completed = await running;
    expect(await f.restart().runSuite(f.ctx, request)).toEqual(completed);
    expect(f.complete).toHaveBeenCalledTimes(12);
  });

  it('rejects target-version, system-prompt, reviewed-suite and authorized branch drift before any repeat calls', async () => {
    const f = setup();
    await f.api.freezeSuite(f.ctx, request);
    await f.api.runSuite(f.ctx, request);
    f.resolved.targetVersion = 'target-config-v2';
    f.resolved.branch.targetVersion = 'target-config-v2';
    await expect(f.restart().runSuite(f.ctx, request)).rejects.toThrow();
    f.resolved.targetVersion = f.resolved.branch.targetVersion = 'target-config-v1';
    f.resolved.systemPrompt = 'Changed trusted prompt';
    await expect(f.restart().runSuite(f.ctx, request)).rejects.toThrow();
    f.resolved.systemPrompt = 'Trusted calendar system prompt.';
    f.resolved.branch.branchId = 'other-authorized-branch';
    await expect(f.restart().runSuite(f.ctx, request)).rejects.toThrow();
    f.resolved.branch.branchId = 'authorized-branch';
    f.resolved.reviewedSuite.scenarios[0].prompt += ' changed';
    await expect(f.restart().runSuite(f.ctx, request)).rejects.toThrow();
    expect(f.complete).toHaveBeenCalledTimes(12);
  });

  it('authorizes every public operation and refuses cross-job or inconsistent branch associations', async () => {
    const f = setup();
    await f.api.freezeSuite(f.ctx, request);
    f.resolved.branch.jobId = randomUUID();
    for (const method of ['freezeSuite', 'getSuite', 'runSuite', 'investigate', 'reportInput'] as const) {
      await expect(f.api[method](f.ctx, request)).rejects.toThrow();
    }
    f.resolved.branch.jobId = f.job.jobId;
    f.resolved.branch.targetVersion = 'wrong-version';
    await expect(f.api.runSuite(f.ctx, request)).rejects.toThrow();
    f.resolved.branch.targetVersion = f.resolved.targetVersion;
    await expect(f.api.runSuite({ ...f.ctx, jobId: randomUUID() }, request)).rejects.toThrow();
    expect(f.complete).not.toHaveBeenCalled();
  });

  it('replays a committed run when its completion acknowledgement was lost', async () => {
    const real = new PostgresTextCheckpointStore(db);
    let lose = true;
    const checkpoints: TextCheckpointStore = {
      claim: k => real.claim(k), get: k => real.get(k), release: (k, t) => real.release(k, t), markAmbiguous: (k, t) => real.markAmbiguous(k, t),
      async complete(k, t, value) { await real.complete(k, t, value); if (k.kind === 'calendar_run' && lose) { lose = false; throw new Error('completion_ack_lost'); } },
    };
    const f = setup({ checkpoints });
    await f.api.freezeSuite(f.ctx, request);
    await expect(f.api.runSuite(f.ctx, request)).rejects.toThrow();
    expect((await f.restart().runSuite(f.ctx, request)).results).toHaveLength(12);
    expect(f.complete).toHaveBeenCalledTimes(12);
  });

  it('blocks an interrupted phase whose result could not persist and never calls the target again', async () => {
    const real = new PostgresTextCheckpointStore(db);
    const checkpoints: TextCheckpointStore = {
      claim: k => real.claim(k), get: k => real.get(k), release: (k, t) => real.release(k, t), markAmbiguous: (k, t) => real.markAmbiguous(k, t),
      async complete(k, t, value) { if (k.kind === 'calendar_run') throw new Error('durable_result_unavailable'); await real.complete(k, t, value); },
    };
    const f = setup({ checkpoints });
    await f.api.freezeSuite(f.ctx, request);
    await expect(f.api.runSuite(f.ctx, request)).rejects.toThrow();
    await expect(f.restart().runSuite(f.ctx, request)).rejects.toThrow();
    expect(f.complete).toHaveBeenCalledTimes(12);
  });

  it('aborts dispatch if intent acknowledgement is lost even when SQL committed the claim', async () => {
    const real = new PostgresTextCheckpointStore(db);
    let lose = true;
    const checkpoints: TextCheckpointStore = {
      get: k => real.get(k), complete: (k, t, v) => real.complete(k, t, v), release: (k, t) => real.release(k, t), markAmbiguous: (k, t) => real.markAmbiguous(k, t),
      async claim(k) { const result = await real.claim(k); if (k.kind === 'calendar_run' && lose) { lose = false; throw new Error('claim_ack_lost'); } return result; },
    };
    const f = setup({ checkpoints });
    await f.api.freezeSuite(f.ctx, request);
    await expect(f.api.runSuite(f.ctx, request)).rejects.toThrow();
    await expect(f.restart().runSuite(f.ctx, request)).rejects.toThrow();
    expect(f.complete).not.toHaveBeenCalled();
  });

  it('retains infrastructure outcomes from lost target responses instead of inventing product failures or retrying', async () => {
    const f = setup({ target: { async complete() { throw new Error('remote accepted request then lost response'); } } });
    await f.api.freezeSuite(f.ctx, request);
    const run = await f.api.runSuite(f.ctx, request);
    expect(run.results.map(r => r.outcome)).toEqual(Array(12).fill('infrastructure_error'));
    expect(await f.restart().runSuite(f.ctx, request)).toEqual(run);
    const investigation = await f.api.investigate(f.ctx, request);
    expect(investigation.reproductions).toEqual([]);
    expect(investigation.findings.every(r => r.status === 'inconclusive' && r.outcome === 'infrastructure_error')).toBe(true);
    const report = await f.restart().reportInput(f.ctx, request);
    expect(report.status).toBe('unresolved');
    expect(report.limitations.join(' ')).toContain('infrastructure_error');
    expect(report.monitoring.checks.every(c => c.outcome === 'infrastructure_error')).toBe(true);
    const rendered = renderCalendarReport({ job: f.job, report, generatedAt: report.suite.frozenAt, costs: null, includeHtml: true });
    expect(rendered.json.evaluationStatus).toBe('unresolved');
    expect(rendered.summary).toContain('Evaluation incomplete');
    expect(rendered.json.summary.counts.confirmed).toBe(0);
    expect(rendered.markdown).toContain('infrastructure\\_error');
    expect(() => renderCalendarReport({ job: f.job, report, generatedAt: report.suite.frozenAt, costs: null,
      knownSecrets: ['Trusted calendar system prompt.'] })).toThrow('unsafe_evidence');
    expect(f.complete).toHaveBeenCalledTimes(12);
  });


  it('preserves unknown claim assessment as unresolved in report and monitoring', async () => {
    const f = setup({ reference: true });
    f.resolved.reviewedSuite.scenarios[0].claimRequiredState = structuredClone(acceptance[0].checks);
    await f.api.freezeSuite(f.ctx, request);
    const run = await f.api.runSuite(f.ctx, request);
    expect(run.results[0].outcome).toBe('inconclusive');
    expect(run.results[0].claim).toBe('unknown');
    expect(run.results[0].stateGrade?.passed).toBe(true);
    const investigation = await f.api.investigate(f.ctx, request);
    expect(investigation.reproductions).toEqual([]);
    const report = await f.api.reportInput(f.ctx, request);
    expect(report.status).toBe('unresolved');
    expect(report.findings[0].status).toBe('inconclusive');
    expect(report.monitoring.checks[0].outcome).toBe('inconclusive');
    expect(report.limitations.join(' ')).toContain('claim_not_assessed');
  });

  it('fences lost investigation completion while preserving committed journal reproduction evidence', async () => {
    const real = new PostgresTextCheckpointStore(db);
    const checkpoints: TextCheckpointStore = {
      claim: k => real.claim(k), get: k => real.get(k), release: (k, t) => real.release(k, t), markAmbiguous: (k, t) => real.markAmbiguous(k, t),
      async complete(k, t, value) { if (k.kind === 'calendar_investigation') throw new Error('lost_investigation_persistence'); await real.complete(k, t, value); },
    };
    const f = setup({ checkpoints });
    await f.api.freezeSuite(f.ctx, request);
    const run = await f.api.runSuite(f.ctx, request);
    await expect(f.api.investigate(f.ctx, request)).rejects.toThrow();
    const calls = f.complete.mock.calls.length;
    await expect(f.restart().investigate(f.ctx, request)).rejects.toThrow();
    await expect(f.restart().reportInput(f.ctx, request)).rejects.toThrow();
    expect(f.complete).toHaveBeenCalledTimes(calls);
    const rows = await engine.query<{ record: { original: { runId: string }; attempts: Array<{ result?: unknown }> } }>('SELECT record FROM app_workflow_investigation_journals');
    const record = rows.rows.find(row => row.record.original.runId === run.runId)?.record;
    expect(record?.attempts).toHaveLength(3);
    expect(record?.attempts.every(attempt => attempt.result !== undefined)).toBe(true);
  });

  it('refuses known secrets before frozen suite checkpoint persistence', async () => {
    const secret = 'fixture-secret-that-must-never-persist-89983';
    const f = setup({ secret });
    f.resolved.reviewedSuite.scenarios[0].prompt = secret;
    await expect(f.api.freezeSuite(f.ctx, request)).rejects.toThrow();
    expect((await engine.query('SELECT * FROM text_integration.checkpoints WHERE job_id=$1', [f.job.jobId])).rows).toEqual([]);
    expect(f.complete).not.toHaveBeenCalled();
  });

  it('refuses target-returned known secrets before checkpoint or journal persistence and fences replay', async () => {
    const secret = 'fixture-target-secret-never-store-831249';
    const f = setup({ secret, target: { async complete() { return { role: 'assistant', content: secret }; } } });
    await f.api.freezeSuite(f.ctx, request);
    await expect(f.api.runSuite(f.ctx, request)).rejects.toThrow();
    await expect(f.restart().runSuite(f.ctx, request)).rejects.toThrow();
    const records = await engine.query('SELECT value FROM text_integration.checkpoints WHERE job_id=$1', [f.job.jobId]);
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(f.complete).toHaveBeenCalledTimes(12);
  });
});

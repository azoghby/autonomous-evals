/**
 * REVIEW CHARACTERIZATION: tests named DEFECT / DEFENSE GAP deliberately assert
 * current undesirable behavior. Green means reproduction succeeds, NOT acceptance.
 * DEFENSE GAP cases mutate a detached trusted projection: they are adapter contract
 * probes, not customer authorization exploits or arbitrary database corruption.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentTransactionalSql } from '../../src/agents/postgres-ports';
import type { ServiceContext } from '../../src/contracts/services';
import type { JobRef } from '../../src/evals/types';
import { createCalendarEvaluationServices } from '../../src/evals/calendar-integration';
import { PostgresTextCheckpointStore } from '../../src/evals/integration/checkpoints';
import { renderCalendarReport } from '../../src/reporting/calendar';
import { calendarAcceptanceScenarios } from '../../src/simulator/acceptance-scenarios';
import { CalendarSimulator } from '../../src/simulator/calendar';
import { PostgresCalendarStore } from '../../src/simulator/postgres';
import type { SqlPool } from '../../src/simulator/pool';
import type { CalendarSuiteInput } from '../../src/simulator/workflow';
import type { ChatTarget } from '../../src/targets/chat';

type Projection = Awaited<ReturnType<ReturnType<typeof createCalendarEvaluationServices>['reportInput']>>;
const generatedAt = '2026-11-07T20:00:00.000Z';
const clone = <T>(value: T): T => structuredClone(value);
const unsafeText = '<script>alert(1)</script>\n[click](javascript:alert(1))\n```';

describe('calendar report independent review', () => {
  let engine: PGlite;
  let report: Projection;
  let job: JobRef;
  let calls = 0;
  beforeAll(async () => {
    engine = new PGlite();
    for (const path of [
      '../../src/simulator/migrations/001_calendar.sql',
      '../../src/simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql',
      '../../src/evals/integration/migrations/001-text-integration.sql',
    ]) await engine.exec(readFileSync(new URL(path, import.meta.url), 'utf8'));
    const db: AgentTransactionalSql = {
      query: <T>(sql: string, params?: unknown[]) => engine.query<T>(sql, params),
      transaction: fn => engine.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })),
    };
    const pool: SqlPool = {
      query: (sql, params) => engine.query(sql, params),
      connect: async () => ({
        query: async (sql, params) => sql.includes('pg_advisory_unlock') ? { rows: [{ unlocked: true }] }
          : sql.includes('pg_advisory_lock') ? { rows: [] } : engine.query(sql, params),
        release() {},
      }),
    };
    job = { jobId: randomUUID(), customerId: 'report-review', environment: 'test', package: 'workflow_eval', isFixture: true, linkedRetestOf: null, quoteVersion: null };
    const ctx: ServiceContext = { jobId: job.jobId, environment: 'test', budgetMicroUsd: 0, recordCost: async () => {}, recordProgress: async () => {} };
    const scenarios = calendarAcceptanceScenarios();
    const reviewedSuite: CalendarSuiteInput = {
      jobId: job.jobId, frozenAt: generatedAt, origin: 'internal_fixture', review: { reviewerId: 'trusted-review', approved: true },
      scenarios: scenarios.map(({ id, prompt, actorId, seed, checks }) => clone({ id, prompt, actorId, seed, checks })),
    };
    const restart = () => createCalendarEvaluationServices({
      checkpoints: new PostgresTextCheckpointStore(db), journalPool: pool,
      resolve: async () => ({ job, reviewedSuite, branch: { jobId: job.jobId, branchId: 'report-branch', targetVersion: 'v1' }, targetVersion: 'v1',
        dependencies: { db, simulator: new CalendarSimulator(new PostgresCalendarStore(db)), targetForScenario: scenario => ({
          complete: (async messages => {
            calls++;
            const index = scenarios.findIndex(s => s.id === scenario.id);
            if (['booking', 'duplicate', 'cancel'].includes(scenario.id)) return { role: 'assistant', content: unsafeText };
            return messages.some(m => m.role === 'tool') ? { role: 'assistant', content: 'Reference complete.' }
              : { role: 'assistant', content: null, tool_calls: clone(scenarios[index].referenceCalls) };
          }) satisfies ChatTarget['complete'],
        }) },
      }),
    });
    const request = { suiteId: 'suite', operationId: 'operation', versionLabel: 'baseline' };
    const suite = await restart().freezeSuite(ctx, request);
    const run = await restart().runSuite(ctx, request);
    const investigation = await restart().investigate(ctx, request);
    report = await restart().reportInput(ctx, request);
    const callCount = calls;
    expect(await restart().runSuite(ctx, request)).toEqual(run);
    expect(await restart().investigate(ctx, request)).toEqual(investigation);
    expect(await restart().reportInput(ctx, request)).toEqual(report);
    expect(calls).toBe(callCount);
    expect(report).toMatchObject({ suite, run, investigation });
    expect(report.findings.filter(f => f.status === 'confirmed')).toHaveLength(3);
  }, 30_000);
  afterAll(async () => { await engine.close(); });

  function render(projection = report, date = generatedAt, knownSecrets: string[] = []) {
    return renderCalendarReport({ job, report: projection, generatedAt: date, knownSecrets, costs: null, includeHtml: true });
  }

  it('preserves full rich evidence and actual reproduction identities after fresh-service replay', () => {
    const result = render();
    expect(result.json.details.calendar).toMatchObject({ suite: report.suite, run: report.run, investigation: report.investigation, monitoring: report.monitoring });
    for (const finding of result.json.findings) {
      const original = report.findings.find(f => f.id === finding.id)!;
      expect(finding.source).toBe('workflow_eval');
      expect(finding.reproduction?.runId).toBe(original.association.reproductionScope?.runId ?? null);
      expect(finding.evidence.some(e => e.kind === 'check')).toBe(true);
    }
    expect(result.summary).toContain('3 confirmed');
    expect(result.summary).not.toContain('No problems');
    expect(result.json.costs.knownMicroUsd).toBeNull();
  });

  it('escapes target-controlled response excerpts in HTML and fences Markdown', () => {
    const result = render();
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.markdown).toContain('````text');
    expect(result.json.findings.some(f => f.evidence.some(e => e.kind === 'scenario_response' && e.quote.includes(unsafeText.split('\n')[0])))).toBe(true);
  });

  it('rejects known credentials in preserved report evidence', () => {
    expect(() => render(report, generatedAt, ['Reference complete.'])).toThrow('calendar_report_unsafe_evidence');
  });

  it('DEFECT: generatedAt bypasses known-secret rejection and leaks into all three artifacts', () => {
    const secret = 'ReviewKnownCredential4239053';
    const result = render(report, secret, [secret]);
    expect(result.json.generatedAt).toBe(secret);
    expect(result.markdown).toContain(secret);
    expect(result.html).toContain(secret);
  });

  it.each(['inconclusive', 'infrastructure_error'] as const)('zero findings cannot hide original %s execution', outcome => {
    const projection = clone(report);
    projection.findings = [];
    projection.investigation.findings = [];
    projection.status = 'completed';
    projection.run.results[0].outcome = outcome;
    const result = render(projection);
    expect(result.json.evaluationStatus).toBe('unresolved');
    expect(result.summary).toContain('No product conclusion');
    expect(result.summary).not.toContain('No problems');
  });

  it('zero findings cannot hide pending reproduction', () => {
    const projection = clone(report);
    projection.findings = [];
    projection.investigation.findings = [];
    projection.investigation.pendingScenarioIds = [projection.run.results[0].scenarioId];
    const result = render(projection);
    expect(result.json.evaluationStatus).toBe('needs_operator');
    expect(result.summary).toContain('Operator reconciliation');
  });

  it('DEFENSE GAP: confirmed status hides missing reproduction evidence', () => {
    const projection = clone(report);
    projection.investigation.reproductions = [];
    const result = render(projection);
    expect(result.json.evaluationStatus).toBe('completed');
    expect(result.json.findings.every(f => f.label === 'confirmed' && f.reproduction?.reproduced === true)).toBe(true);
    expect(result.json.details.calendar).toMatchObject({ investigation: { reproductions: [] } });
  });

  it('DEFENSE GAP: confirmed label hides infrastructure outcome in actual reproduction evidence', () => {
    const projection = clone(report);
    projection.investigation.reproductions[0].result.outcome = 'infrastructure_error';
    projection.investigation.reproductions[0].result.reason = 'execution_unavailable';
    const result = render(projection);
    expect(result.json.evaluationStatus).toBe('completed');
    expect(result.json.findings[0].reproduction?.reproduced).toBe(true);
    expect(result.json.details.calendar).toMatchObject({ investigation: { reproductions: [
      { result: { outcome: 'infrastructure_error' } }, {}, {},
    ] } });
  });

  it('DEFENSE GAP: claimed reproduction scope can belong to another job', () => {
    const projection = clone(report);
    projection.findings[0].association.reproductionScope = { jobId: 'different-job', runId: 'invented-reproduction', version: 'different-version' };
    const result = render(projection);
    expect(result.json.findings[0].reproduction).toMatchObject({ reproduced: true, runId: 'invented-reproduction' });
  });

  it('DEFENSE GAP: zero findings hides infrastructure reproduction evidence', () => {
    const projection = clone(report);
    projection.findings = [];
    projection.investigation.findings = [];
    projection.investigation.reproductions[0].result.outcome = 'infrastructure_error';
    projection.investigation.reproductions[0].result.reason = 'execution_unavailable';
    const result = render(projection);
    expect(result.json.evaluationStatus).toBe('completed');
    expect(result.json.findings).toEqual([]);
    expect(result.summary).toContain('No problems');
  });

  it('rejects original finding branch mismatch', () => {
    const projection = clone(report);
    projection.findings[0].association.branchId = 'different-branch';
    expect(() => render(projection)).toThrow('identity_mismatch');
  });
});

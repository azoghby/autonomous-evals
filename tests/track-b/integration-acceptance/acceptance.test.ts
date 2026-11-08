import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresAgentTaskStore, PostgresBudgetLedger, type AgentTransactionalSql } from './src/agents/postgres-ports';
import { AgentSessionService } from './src/agents/session-service';
import { harness, fixtureJob } from './src/agents/__tests__/fakes';
import { composeEvalServices, EvalServiceUnavailableError } from './src/integration/compose';
import { Suite } from './src/contracts/index';
import type { ServiceContext } from './src/contracts/services';
import { formatUsd } from './src/evals/types';
import type { CostEntry, JobRef } from './src/evals/types';
import { createTrackBServices } from './src/evals/service-adapter';
import { createTextEvaluationServices } from './src/evals/integration/services';
import { PostgresTextCheckpointStore } from './src/evals/integration/checkpoints';
import { makeScenarios } from './src/evals/text/__tests__/fixtures';
import { createCalendarEvaluationServices } from './src/evals/calendar-integration';
import { calendarAcceptanceScenarios } from './src/simulator/acceptance-scenarios';
import { CalendarSimulator } from './src/simulator/calendar';
import { PostgresCalendarStore } from './src/simulator/postgres';
import type { ChatTarget } from './src/targets/chat';
import type { SqlPool } from './src/simulator/pool';
import { renderCalendarReport } from './src/reporting/calendar';
import { createProgressChatService } from './src/reporting/chat/service';
import { createPostgresConversationPort } from './src/reporting/chat/postgres-conversations';
import { createDurableProgressProjection } from './src/reporting/chat/projection';
import { createDurableProgressReader } from './src/reporting/chat/projection/reader';
import type { ProjectionPlan } from './src/reporting/chat/projection/types';
import { acquireEvaluationData } from './src/evals/data/acquisition';
import { createPostgresEvaluationDataStore } from './src/evals/data/postgres-store';
import { mapApprovedDataToTextDesign } from './src/evals/data/adapters/mapping';

const time = '2026-11-07T20:00:00.000Z';
const trace = JSON.stringify([
  { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'send_email', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: '{"ok":false,"error":"smtp down"}' },
  { role: 'assistant', content: 'The email was sent.' },
]);
let sql: PGlite;
let db: AgentTransactionalSql;
const checkpoints = () => new PostgresTextCheckpointStore(db);
const dataStore = (jobId: string, executor = db) => createPostgresEvaluationDataStore(executor, { tenantId: 'fixture-customer', jobId });

beforeAll(async () => {
  sql = new PGlite();
  for (const path of [
    'agents/persistence-migrations/001-agent-persistence.sql',
    'evals/integration/migrations/001-text-integration.sql',
    'simulator/migrations/001_calendar.sql',
    'simulator/workflow/persistence-migrations/001-workflow-investigation-journals.sql',
    'reporting/chat/persistence-migrations/001-conversations.sql',
    'evals/data/persistence-migrations/001-evaluation-data.sql',
  ]) await sql.exec(readFileSync(new URL(`./src/${path}`, import.meta.url), 'utf8'));
  // Acceptance-owned tables model the parent's durable context ports, not app schema.
  await sql.exec('CREATE TABLE acceptance_costs(job_id text, key text, value jsonb, PRIMARY KEY(job_id,key)); CREATE TABLE acceptance_jobs(job_id text PRIMARY KEY, status text, updated_at text)');
  db = { query: (q, p) => sql.query(q, p), transaction: fn => sql.transaction(tx => fn({ query: (q, p) => tx.query(q, p) })) };
}, 30000);
afterAll(async () => { await sql?.close(); });

function context(job: JobRef): ServiceContext {
  return { jobId: job.jobId, environment: 'test', budgetMicroUsd: 1_000_000,
    recordCost: async c => { await sql.query('INSERT INTO acceptance_costs VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [job.jobId, c.meta?.idempotencyKey, JSON.stringify(c)]); },
    recordProgress: async () => {},
  };
}
async function costs(jobId: string, executor: Pick<AgentTransactionalSql, 'query'> = db): Promise<CostEntry[]> {
  const rows = await executor.query<{ value: { sessionId: string; microUsd: number; meta: { purpose: string; measured: boolean } } }>('SELECT value FROM acceptance_costs WHERE job_id=$1 ORDER BY key', [jobId]);
  return rows.rows.map(({ value }) => ({ jobId, source: 'naive_session', role: null, externalId: value.sessionId, purpose: value.meta.purpose, measured: value.meta.measured, microUsd: value.microUsd, recordedAt: time }));
}
async function saveJob(job: JobRef, status = 'running') {
  await sql.query('INSERT INTO acceptance_jobs VALUES($1,$2,$3) ON CONFLICT(job_id) DO UPDATE SET status=$2', [job.jobId, status, time]);
}
async function runPlan(job: JobRef, format: 'text_run' | 'calendar_run', run: { runId: string }, suiteDigest: string, scenarioIds: string[], branchId?: string): Promise<ProjectionPlan> {
  const result = await sql.query<{ kind: string; id: string; input_digest: string }>('SELECT kind,id,input_digest FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2', [job.jobId, format === 'text_run' ? 'run_result' : 'calendar_run']);
  expect(result.rows).toHaveLength(1);
  const row = result.rows[0]!;
  const plan: ProjectionPlan = { scope: { subjectId: 'owner', jobId: job.jobId }, environment: 'test', acquisitionTaskIds: [], checkpoints: [{ key: { jobId: job.jobId, kind: row.kind, id: row.id, inputDigest: row.input_digest }, phase: 'running', format, runId: run.runId, suiteDigest, scenarioIds, ...(branchId ? { branchId } : {}) }] };
  const investigationKind = format === 'text_run' ? 'investigation' : 'calendar_investigation';
  const investigations = await sql.query<{ id: string; input_digest: string }>('SELECT id,input_digest FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2', [job.jobId, investigationKind]);
  expect(investigations.rows).toHaveLength(1);
  const saved = investigations.rows[0]!;
  plan.checkpoints.push({ ...plan.checkpoints[0]!, key: { jobId: job.jobId, kind: investigationKind, id: saved.id, inputDigest: saved.input_digest }, phase: 'investigating', format: format === 'text_run' ? 'text_investigation' : 'calendar_investigation' });
  return plan;
}
function chat(plan: ProjectionPlan) {
  let subject = 'owner'; let allowed = true;
  const access = { authenticate: async () => ({ subjectId: subject }), resolveAuthorizedJob: async (caller: { subjectId: string }, jobId: string) => allowed && jobId === plan.scope.jobId ? { subjectId: caller.subjectId, jobId } : null };
  const projection = createDurableProgressProjection({ access, referenceKey: 'acceptance-local-reference-key-32-bytes-long',
    resolve: async scope => ({ ...plan, scope }),
    reader: createDurableProgressReader({ withRead: (p, work) => db.transaction(async tx => {
      const row = (await tx.query<{ status: 'running' | 'delivered'; updated_at: string }>('SELECT status,updated_at FROM acceptance_jobs WHERE job_id=$1', [p.scope.jobId])).rows[0]!;
      // Serialized local PGlite transaction is a consistent view. Real parent must
      // supply authorization/inventory revision checks + repeatable-read/session SQL.
      return work({ observedAt: time, job: { jobId: p.scope.jobId, status: row.status, updatedAt: row.updated_at }, costs: await costs(p.scope.jobId, tx), unknownCosts: true,
        checkpoints: new PostgresTextCheckpointStore({ ...db, query: tx.query }), acquisition: dataStore(p.scope.jobId, { ...db, query: tx.query }) });
    }) }),
  });
  const restart = () => createProgressChatService({ access, progress: projection, conversations: createPostgresConversationPort(db) });
  return { projection, restart, subject: (s: string) => { subject = s; }, deny: () => { allowed = false; } };
}

async function textSeam(jobId: string) {
    const job = fixtureJob({ jobId, package: 'text_eval' }); const ctx = context(job); await saveJob(job);
    const h = harness(body => ({ structuredOutput: body.metadata.ae_output === 'text_design' ? { scenarios: makeScenarios() } : body.metadata.ae_output === 'text_review'
      ? { verdicts: makeScenarios().map(s => ({ scenarioId: s.id, accepted: true, reasons: [] })) }
      : { reproduceScenarioIds: ['S01', 'S02', 'S03'], verdicts: ['S01', 'S02', 'S03'].map(id => ({ candidateId: `text:${id}:${id}.o1`, verdict: 'confirmed', rationale: 'Repeated constraint violation.', quote: 'WRONG', defectNote: null })) } }), { store: new PostgresAgentTaskStore(db), ledger: new PostgresBudgetLedger(db) });
    const send = vi.fn(async () => ({ ok: true as const, text: 'WRONG', latencyMs: 1 }));
    const restart = () => createTextEvaluationServices({ runner: new AgentSessionService(h.deps), checkpoints: checkpoints(), resolve: async () => ({ job, target: { send }, targetVersion: 'v1', judge: null }), clock: h.clock });
    const outcome = await restart().designSuite(ctx, { suiteId: 'suite', versionLabel: 'v1', systemPrompt: null, referenceText: null });
    if (outcome.status !== 'completed') throw new Error('design failed');
    const request = { suiteDigest: outcome.suite.digest, runId: 'baseline' };
    const run = await restart().runSuite(ctx, request);
    const investigation = await restart().investigate(ctx, request);
    expect(investigation.reproductions).toHaveLength(3);
    expect(investigation.findings.filter(f => f.label === 'confirmed')).toHaveLength(3);
    const reportInput = await restart().reportInput(ctx, request);
    const report = await createTrackBServices({ runner: h.service, resolveJob: async () => job, operatorSummary: false, listJobCosts: (id: string) => costs(id) }).renderReport(ctx, {
      intake: { package: 'text_eval', endpoint: { url: 'https://fixture.invalid/v1', model: 'fixture', systemPrompt: '' }, authorizedToTest: true }, findings: [], richFindings: reportInput.richFindings, limitations: reportInput.limitations,
    });
    expect(reportInput.run).toEqual(run); expect(report.markdown).toContain('WRONG');
    expect(report.findings.filter(f => f.status === 'confirmed')).toHaveLength(3); expect(reportInput.suite.referenceText).toBeNull();
    const c = chat(await runPlan(job, 'text_run', run, outcome.suite.digest, run.executions.map(e => e.scenarioId)));
    const projected = await c.projection.project({ subjectId: 'owner', jobId: job.jobId });
    expect(projected.phases[0]?.outcomes.length).toBeGreaterThan(0); expect(projected.snapshot.status).toBe('running');
    expect(projected.snapshot.costs.reduce((n, cost) => n + cost.microUsd, 0)).toBe((await costs(job.jobId)).reduce((n, cost) => n + cost.microUsd, 0));
    expect(projected.snapshot.unknownCosts).toBe(true); expect(JSON.stringify(projected)).not.toContain('WRONG');
    const message = { jobId: job.jobId, messageId: 'question', question: 'What is the progress and cost?' };
    const reply = await c.restart().send(message);
    expect(reply.reply.asOf).toBe(time);
    expect(await c.restart().send(message)).toEqual(reply);
    c.subject('other-authorized-viewer'); expect((await c.restart().history({ jobId: job.jobId })).messages).toEqual([]);
    c.subject('owner'); expect((await c.restart().history({ jobId: job.jobId })).messages).toHaveLength(1);
    c.deny();
    for (const op of [() => c.restart().send(message), () => c.restart().history({ jobId: job.jobId }), () => c.restart().poll({ jobId: job.jobId })]) await expect(op()).rejects.toMatchObject({ code: 'not_found' });
    expect(await restart().runSuite(ctx, request)).toEqual(run); expect(send).toHaveBeenCalledTimes(15);
    return { projected, investigation };
}

// These tests compose production engines/stores. Only external provider output,
// trusted authorization and the parent-owned context/consistent-read ports are fixtures.
describe('ACCEPTANCE — locally composed durable seams', () => {
  it('A1 Trace Audit uses Track A composition, preserves failed-tool evidence in report and deduplicates measured replay costs', async () => {
    const job = fixtureJob({ jobId: 'acceptance-trace' }); const ctx = context(job);
    const h = harness(body => {
      if (!body.message.includes('Trace Audit candidates')) return { structuredOutput: { executive_summary: 'Confirmed false success after a failed send.', finding_notes: [], recommended_next_steps: [], retest_recommended: false } };
      const data = JSON.parse(body.message.slice(body.message.indexOf('<untrusted_data>') + 16, body.message.indexOf('</untrusted_data>')));
      return { structuredOutput: { verdicts: data.candidates.map((c: { candidate_id: string }) => ({ candidate_id: c.candidate_id, verdict: 'confirmed', rationale: 'Failed send contradicts success.', evidence: [], defect_note: null })), additional_findings: [] } };
    }, { store: new PostgresAgentTaskStore(db), ledger: new PostgresBudgetLedger(db) });
    const branches = vi.fn(async (): Promise<never> => { throw new Error('branches must not be needed for Trace Audit'); });
    const build = (ledger = true) => composeEvalServices({ agents: async () => ({ runner: new AgentSessionService({ ...h.deps, store: new PostgresAgentTaskStore(db), ledger: new PostgresBudgetLedger(db) }), resolveJob: async () => job, clock: h.clock, ...(ledger ? { listJobCosts: (id: string) => costs(id) } : {}) }), branches });
    const audit = await build().auditTrace(ctx, trace);
    expect(audit.findings.some(f => f.status === 'confirmed')).toBe(true);
    expect(JSON.stringify(audit.findings)).toContain('smtp down');
    const input = { intake: { package: 'trace_audit' as const, trace, authorizedToTest: true as const }, findings: audit.findings };
    const report = await build().renderReport(ctx, input);
    expect(report.findings.map(({ id, status, evidence }) => ({ id, status, evidence }))).toEqual(audit.findings.map(({ id, status, evidence }) => ({ id, status, evidence })));
    expect(report.markdown).toContain('smtp down');
    expect(report.html).toBeTruthy();
    const recorded = await costs(job.jobId);
    expect(recorded).toHaveLength(2); expect(recorded.reduce((n, c) => n + c.microUsd, 0)).toBe(24690);
    expect(report.markdown).toContain(`Known costs for this job: ${formatUsd(24690)}`);
    expect(await build().auditTrace(ctx, trace)).toEqual(audit);
    expect(await build().renderReport(ctx, input)).toEqual(report);
    expect(await costs(job.jobId)).toHaveLength(2); expect(h.naive.createCalls).toHaveLength(2);
    expect(branches).not.toHaveBeenCalled();
    const unknown = await build(false).renderReport(ctx, input);
    expect(unknown.markdown.toLowerCase()).toContain('unknown');
  });

  it('A2 Text SQL checkpoints feed real reporting and authorized private persisted chat without replay target calls', async () => { await textSeam('acceptance-text'); });

  it('A3 Calendar unresolved infrastructure evidence survives SQL replay, report and progress without a false pass or reproduction', async () => {
    const job = fixtureJob({ jobId: 'acceptance-calendar', package: 'workflow_eval' }); const ctx = context(job); await saveJob(job);
    const complete = vi.fn(async (): Promise<never> => { throw new Error('lost target response'); });
    // Local single-backend journal fixture: advisory lock calls alone are modeled.
    // Native PostgreSQL multi-session locking is explicitly outside this test.
    const pool: SqlPool = { query: (q, p) => sql.query(q, p), connect: async () => ({ query: async (q, p) => q.includes('pg_advisory_unlock') ? { rows: [{ unlocked: true }] } : q.includes('pg_advisory_lock') ? { rows: [] } : sql.query(q, p), release: () => {} }) };
    const reviewedSuite = { jobId: job.jobId, origin: 'internal_fixture' as const, frozenAt: time, review: { reviewerId: 'trusted-reviewer', approved: true as const }, scenarios: calendarAcceptanceScenarios().map(({ id, prompt, actorId, seed, checks }) => ({ id, prompt, actorId, seed, checks })) };
    const restart = () => createCalendarEvaluationServices({ checkpoints: checkpoints(), journalPool: pool, resolve: async () => ({ job, targetVersion: 'v1', branch: { jobId: job.jobId, branchId: 'branch', targetVersion: 'v1' }, reviewedSuite, systemPrompt: '', dependencies: { db, simulator: new CalendarSimulator(new PostgresCalendarStore(db)), targetForScenario: () => ({ complete }) } }) });
    const request = { suiteId: 'suite', operationId: 'baseline', versionLabel: 'v1' };
    const suite = await restart().freezeSuite(ctx, request);
    const run = await restart().runSuite(ctx, request); const investigation = await restart().investigate(ctx, request);
    const report = await restart().reportInput(ctx, request);
    expect(run.results.every(r => r.outcome === 'infrastructure_error')).toBe(true); expect(investigation.reproductions).toEqual([]);
    const rendered = renderCalendarReport({ job, report, generatedAt: time, costs: null });
    expect(rendered.json.evaluationStatus).toBe('unresolved'); expect(rendered.json.summary.counts.confirmed).toBe(0);
    expect(rendered.json.details.calendar).toMatchObject({ run, investigation });
    const c = chat(await runPlan(job, 'calendar_run', run, suite.hash, run.results.map(r => r.scenarioId), run.branchId));
    const p = await c.projection.project({ subjectId: 'owner', jobId: job.jobId });
    expect(p.phases[0]?.outcomes).toContain('infrastructure_error'); expect(p.snapshot.blockers.length).toBeGreaterThan(0);
    expect((await c.restart().poll({ jobId: job.jobId })).reply?.unknowns.length).toBeGreaterThan(0);
    await saveJob(job, 'delivered'); await expect(c.restart().poll({ jobId: job.jobId })).rejects.toMatchObject({ code: 'invalid_snapshot' });
    expect(await restart().runSuite(ctx, request)).toEqual(run); expect(complete).toHaveBeenCalledTimes(12);
  });

  it('A5 Calendar fixed reference passes SQL checks while a no-op fixture yields reproduced failures in the exported report', async () => {
    const fixtures = calendarAcceptanceScenarios();
    const pool: SqlPool = { query: (q, p) => sql.query(q, p), connect: async () => ({ query: async (q, p) => q.includes('pg_advisory_unlock') ? { rows: [{ unlocked: true }] } : q.includes('pg_advisory_lock') ? { rows: [] } : sql.query(q, p), release: () => {} }) };
    for (const fixed of [true, false]) {
      const job = fixtureJob({ jobId: fixed ? 'acceptance-fixed-calendar' : 'acceptance-buggy-calendar', package: 'workflow_eval' });
      const ctx = context(job); await saveJob(job);
      let calls = 0;
      const reviewedSuite = { jobId: job.jobId, origin: 'internal_fixture' as const, frozenAt: time, review: { reviewerId: 'trusted-reviewer', approved: true as const }, scenarios: fixtures.map(({ id, prompt, actorId, seed, checks }) => ({ id, prompt, actorId, seed, checks })) };
      const restart = () => createCalendarEvaluationServices({ checkpoints: checkpoints(), journalPool: pool, resolve: async () => ({ job, targetVersion: 'v1', branch: { jobId: job.jobId, branchId: 'branch', targetVersion: 'v1' }, reviewedSuite, systemPrompt: '', dependencies: {
        db, simulator: new CalendarSimulator(new PostgresCalendarStore(db)), targetForScenario: (scenario: { id: string }): ChatTarget => ({ complete: async messages => {
          calls++;
          return !fixed || messages.some(m => m.role === 'tool') ? { role: 'assistant', content: 'No further action.' }
            : { role: 'assistant', content: null, tool_calls: structuredClone(fixtures.find(f => f.id === scenario.id)!.referenceCalls) };
        } }),
      } }) });
      const request = { suiteId: 'suite', operationId: 'baseline', versionLabel: 'v1' };
      const suite = await restart().freezeSuite(ctx, request);
      const run = await restart().runSuite(ctx, request);
      const investigation = await restart().investigate(ctx, request);
      const report = await restart().reportInput(ctx, request);
      const rendered = renderCalendarReport({ job, report, generatedAt: time, costs: null });
      if (fixed) {
        expect(run.results.every(r => r.outcome === 'passed' && r.stateGrade?.passed)).toBe(true);
        expect(investigation.findings).toEqual([]); expect(investigation.reproductions).toEqual([]);
      } else {
        expect(run.results.some(r => r.outcome === 'product_failure')).toBe(true);
        expect(investigation.reproductions).toHaveLength(3);
        expect(rendered.json.findings.filter(f => f.label === 'confirmed')).toHaveLength(3);
        expect(rendered.json.findings.filter(f => f.label === 'confirmed').every(f => f.reproduction?.attempted)).toBe(true);
      }
      expect(rendered.json.details.calendar).toMatchObject({ run, investigation });
      const c = chat(await runPlan(job, 'calendar_run', run, suite.hash, run.results.map(r => r.scenarioId), run.branchId));
      const progress = await c.projection.project({ subjectId: 'owner', jobId: job.jobId });
      expect(progress.phases[0]?.outcomes).toContain(fixed ? 'passed' : 'product_failure');
      expect(progress.snapshot.status).toBe('running');
      const dispatched = calls;
      expect(await restart().runSuite(ctx, request)).toEqual(run);
      expect(await restart().reportInput(ctx, request)).toEqual(report);
      expect(calls).toBe(dispatched);
    }
  });

  it('A4 Missing data and expert verification stay durable blockers and cannot become factual Text design input', async () => {
    const job = fixtureJob({ jobId: 'acceptance-data', package: 'text_eval' }); await saveJob(job);
    const spec = { taskId: 'acceptance-data-task', jobId: job.jobId, targetId: 'target', description: 'Arithmetic fixture', factualAnswersRequired: true, requirements: [{ id: 'math', description: 'Addition', minimumCases: 1 }] };
    const empty = { sources: [], cases: [] };
    const ports = { store: dataStore(job.jobId), now: () => new Date(time), discover: vi.fn(async () => ({ status: 'pending' as const })), generate: vi.fn(async () => ({ status: 'complete' as const, data: { sources: [], cases: [{ id: 'candidate', input: 'Two plus two?', expectedAnswer: '4', requirementIds: ['math'], sourceIds: [], synthetic: true, generatorId: 'generator' }] } })), expert: vi.fn(async () => ({ status: 'pending' as const })) };
    let task = await acquireEvaluationData(spec, empty, ports);
    expect(task.state).toBe('waiting_for_data');
    const plan: ProjectionPlan = { scope: { subjectId: 'owner', jobId: job.jobId }, environment: 'test', checkpoints: [], acquisitionTaskIds: [spec.taskId] };
    const c = chat(plan);
    expect((await c.projection.project(plan.scope)).snapshot.blockers[0]?.kind).toBe('input');
    const context = { job, versionLabel: 'v1', systemPrompt: null };
    expect(mapApprovedDataToTextDesign(task, context).status).toBe('blocked');
    task = await acquireEvaluationData(spec, empty, { ...ports, discover: async () => ({ status: 'complete', data: empty }) });
    task = await acquireEvaluationData(spec, empty, ports);
    expect(task.state).toBe('waiting_for_expert');
    expect(await dataStore(job.jobId).get(spec.taskId)).toEqual(task);
    expect(mapApprovedDataToTextDesign(task, context).status).toBe('blocked');
    const p = await c.projection.project(plan.scope);
    expect(p.acquisition[0]?.state).toBe('waiting_for_expert'); expect(p.snapshot.blockers[0]?.kind).toBe('input');
    expect(task.assessment.factualCorrectness).toBe('unassessed'); expect(task.assessment.approvedAnswerCaseIds).toEqual([]);
    await saveJob(job, 'delivered'); await expect(c.restart().poll({ jobId: job.jobId })).rejects.toMatchObject({ code: 'invalid_snapshot' });
  });
});

describe('CHARACTERIZATION — open integration gaps, not acceptance', () => {
  it('G4 persisted confirmed Text findings are absent from private chat projection', async () => {
    const { projected, investigation } = await textSeam('acceptance-text-gap');
    expect(investigation.findings.filter(f => f.label === 'confirmed')).toHaveLength(3);
    expect(projected.snapshot.findings).toEqual([]);
  });
  it('G2 shared finding round trip appends unspecified basis to an objective Trace finding', async () => {
    const job = fixtureJob({ jobId: 'acceptance-basis-gap' });
    const h = harness(() => { throw new Error('operator disabled'); });
    const finding = { id: 'F1', title: 'Unsupported send', status: 'confirmed' as const, severity: 'high' as const, category: 'unsupported_claim' as const, description: 'Tool failed.\n\nBasis: objective.', evidence: [{ kind: 'trace_excerpt' as const, excerpt: 'smtp down', location: 'event e2' }], reproductions: 0 };
    const report = await createTrackBServices({ runner: h.service, resolveJob: async () => job, operatorSummary: false }).renderReport(context(job), {
      intake: { package: 'trace_audit', trace, authorizedToTest: true }, findings: [finding],
    });
    expect(report.findings[0]?.description).toContain('Basis: objective.\n\nBasis: unspecified.');
    expect(h.naive.createCalls).toHaveLength(0);
  });
  it('G3 Track A accepts 32 shared scenarios but this establishes no appended red-team execution', () => {
    const scenario = { id: 'S1', title: 'Schema fixture', category: 'instruction', input: 'Return READY', checks: [{ kind: 'objective', description: 'Exact answer', spec: {} }] };
    const suite = { jobId: '7d3f0c5e-4b1a-4e8e-9d55-0a1b2c3d4e5f', versionLabel: 'v1', frozenAt: time, scenarios: Array.from({ length: 32 }, (_, i) => ({ ...scenario, id: `S${i}` })) };
    expect(Suite.safeParse(suite).success).toBe(true);
    expect(Suite.safeParse({ ...suite, scenarios: [...suite.scenarios, { ...scenario, id: 'S33' }] }).success).toBe(false);
  });
  it('G1 actual Track A composition refuses Text/Calendar legacy phases, rerun and verified remediation', () => {
    const factory = vi.fn(async (): Promise<never> => { throw new Error('must not initialize a provider'); });
    const svc = composeEvalServices({ agents: factory, branches: factory });
    // Invoke the actual unavailable closures with opaque fixture arguments; no
    // passing implementation is substituted for any missing service.
    for (const name of ['designSuite', 'runSuite', 'investigate', 'rerunFinding', 'proposeAndVerifyFix'] as const) {
      expect(() => Reflect.apply(svc[name], svc, [])).toThrow(EvalServiceUnavailableError);
    }
    expect(factory).not.toHaveBeenCalled();
  });
});

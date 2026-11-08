/** Offline boundary scripts only; all session persistence and reservations use production SQL adapters. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { AgentSessionService } from '../../../../packages/core/src/agents/session-service';
import { PostgresAgentTaskStore, PostgresBudgetLedger } from '../../../../packages/core/src/agents/postgres-ports';
import type { AgentTransactionalSql } from '../../../../packages/core/src/agents/postgres-ports';
import { PostgresTextCheckpointStore } from '../../../../packages/core/src/evals/integration/checkpoints';
import { createTrackBServices, TrackBBlockedError, TrackBPendingError } from '../../../../packages/core/src/evals/service-adapter';
import { renderReport } from '../../../../packages/core/src/reporting/render';
import type { CostEntry, JobRef, NaiveSessionSnapshot, NaiveSessionsPort } from '../../../../packages/core/src/evals/types';
import type { ServiceContext } from '../../../../packages/core/src/contracts/services';

const job: JobRef = { jobId: 'cross-cost-job', customerId: 'fixture', package: 'trace_audit', environment: 'test', isFixture: true, linkedRetestOf: null, quoteVersion: null };
const intake = { package: 'trace_audit' as const, trace: 'Offline supplied trace.', authorizedToTest: true as const };
const time = '2026-11-07T20:00:00.000Z';
const qualification = { decision: 'quote', recommended_package: 'trace_audit', questions: [], scope_summary: 'Review the supplied trace.', decline_reason: null };

type Script = Pick<NaiveSessionSnapshot, 'status' | 'stopReason' | 'stopCode' | 'structuredOutput' | 'consumedMicroUsd'>;
class LocalSessions implements NaiveSessionsPort {
  creates = 0; polls = 0;
  script: Script = { status: 'idle', stopReason: 'end_turn', stopCode: null, structuredOutput: qualification, consumedMicroUsd: 125_001 };
  sessions = new Map<string, NaiveSessionSnapshot>();
  async createSession(body: Parameters<NaiveSessionsPort['createSession']>[0]) {
    const id = `ses_cost_${++this.creates}`;
    const session: NaiveSessionSnapshot = { id, agentId: body.agent_id, agentVersion: 1, budgetMicroUsd: body.budget_micro_usd,
      metadata: body.metadata, tokenUsage: { input: 11, output: 7 }, ...this.script };
    this.sessions.set(id, session);
    return { ...session, status: 'running' as const, stopReason: null, structuredOutput: null };
  }
  async getSession(id: string) { this.polls++; const session = this.sessions.get(id); assert.ok(session); return { ...session, ...this.script }; }
  async listAgentSessions() { throw new Error('unexpected recovery scan'); return { data: [], nextCursor: null }; }
}

/** Caller owns path and cleanup; close/reopen is exercised by each case. */
async function open(path: string, initialize = false) {
  const engine = new PGlite(path);
  if (initialize) for (const relative of ['agents/persistence-migrations/001-agent-persistence.sql', 'evals/integration/migrations/001-text-integration.sql']) {
    await engine.exec(await readFile(new URL(`../../../../packages/core/src/${relative}`, import.meta.url), 'utf8'));
  }
  const db: AgentTransactionalSql = { query: <T>(sql: string, params?: unknown[]) => engine.query<T>(sql, params),
    transaction: fn => engine.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })) };
  return { engine, db, store: new PostgresAgentTaskStore(db), ledger: new PostgresBudgetLedger(db), checkpoints: new PostgresTextCheckpointStore(db) };
}
type Open = Awaited<ReturnType<typeof open>>;
function bind(sql: Open, naive: LocalSessions, loseAck = false) {
  const runner = new AgentSessionService({ naive, store: sql.store, ledger: sql.ledger,
    directory: { commercial: { agentId: 'agt_local_c' }, company_operator: { agentId: 'agt_local_o' }, evaluation_engineer: { agentId: 'agt_local_e' }, quality_investigator: { agentId: 'agt_local_i' } },
    budgetPeriodId: 'cross-cost-test', idempotencyNamespace: 'offline', workerId: 'local', clock: { now: () => new Date(time) }, maxWaitMs: 0 });
  let writes = 0;
  // Test-owned application sink: the production contract requires atomic session-key idempotency.
  // Use the real checkpoint adapter, rather than a map or an invented production cost repository.
  const ctx: ServiceContext = { jobId: job.jobId, environment: 'test', budgetMicroUsd: 500_000, recordProgress: async () => {},
    recordCost: async cost => {
      writes++;
      const id = String(cost.meta?.idempotencyKey);
      assert.equal(id, `naive:${cost.sessionId}`);
      const key = { jobId: job.jobId, kind: 'release_cost_sink', id, inputDigest: JSON.stringify(cost) };
      const claim = await sql.checkpoints.claim(key);
      if (claim.state === 'claimed') await sql.checkpoints.complete(key, claim.token, cost);
      else { assert.equal(claim.state, 'completed'); if (claim.state === 'completed') assert.deepEqual(claim.value, JSON.parse(JSON.stringify(cost))); }
      if (loseAck) { loseAck = false; throw new Error('cost commit ACK lost'); }
    } };
  async function listJobCosts(jobId: string): Promise<CostEntry[]> {
    const rows = await sql.engine.query<{ value: { sessionId: string; microUsd: number } }>("SELECT value FROM text_integration.checkpoints WHERE job_id = $1 AND kind = 'release_cost_sink' AND state = 'completed' ORDER BY id", [jobId]);
    return rows.rows.map(({ value }) => ({ jobId, source: 'naive_session', role: null, externalId: value.sessionId, purpose: 'durable_sink', microUsd: value.microUsd, measured: true, recordedAt: time }));
  }
  const service = createTrackBServices({ runner, resolveJob: async () => job, listJobCosts, clock: { now: () => new Date(time) } });
  return { ctx, service, listJobCosts, writes: () => writes };
}
async function accounting(sql: Open) {
  const result = await sql.engine.query<{ consumed: number | null; settled: string | null; reserved: string }>(`SELECT (t.record->>'consumedMicroUsd')::bigint::float8 AS consumed, r.settled_micro_usd::text AS settled, r.amount_micro_usd::text AS reserved
    FROM agent_persistence.tasks t JOIN agent_persistence.reservations r ON r.id = t.record->>'reservationId' ORDER BY t.task_key`);
  return result.rows;
}

export async function failedServicesRetainMeasuredCosts(path: string) {
  let sql = await open(path, true);
  const naive = new LocalSessions();
  try {
    naive.script = { ...naive.script, status: 'failed', stopReason: 'error', stopCode: 'offline_failure' };
    let b = bind(sql, naive);
    await assert.rejects(b.service.qualify(b.ctx, intake, []), e => e instanceof TrackBBlockedError && e.code === 'agent_failed');
    assert.deepEqual((await b.listJobCosts(job.jobId)).map(c => c.microUsd), [125_001]);
    // A different service/role fails schema validation; fallback report still includes both measured sessions.
    naive.script = { ...naive.script, status: 'idle', stopReason: 'end_turn', stopCode: null, structuredOutput: { invalid: true }, consumedMicroUsd: 250_002 };
    const report = await b.service.renderReport(b.ctx, { intake, findings: [] });
    assert.match(report.markdown, /Known costs for this job: \$0\.38/);
    assert.match(report.html, /\$0\.38/);
    assert.match(report.markdown, /Hosting and infrastructure/);
    assert.deepEqual((await accounting(sql)).map(r => r.settled).sort(), ['125001', '250002']);
    await sql.engine.close(); sql = await open(path); b = bind(sql, naive);
    const polls = naive.polls;
    await assert.rejects(b.service.qualify(b.ctx, intake, []), TrackBBlockedError);
    assert.deepEqual(await b.service.renderReport(b.ctx, { intake, findings: [] }), report);
    assert.equal(naive.creates, 2); assert.equal(naive.polls, polls);
    assert.equal((await b.listJobCosts(job.jobId)).length, 2);
    assert.deepEqual(await b.listJobCosts('another-job'), []);
  } finally { await sql.engine.close(); }
}

export async function pendingThenSettledCosts(path: string) {
  let sql = await open(path, true);
  const naive = new LocalSessions();
  try {
    naive.script = { ...naive.script, status: 'running', stopReason: null, structuredOutput: null, consumedMicroUsd: 17_000 };
    let b = bind(sql, naive);
    await assert.rejects(b.service.qualify(b.ctx, intake, []), TrackBPendingError);
    assert.equal(b.writes(), 0); assert.deepEqual(await b.listJobCosts(job.jobId), []);
    const rows = await accounting(sql);
    assert.equal(rows.length, 1); assert.equal(rows[0].consumed, null); assert.equal(rows[0].settled, null); assert.ok(Number(rows[0].reserved) > 0);
    await sql.engine.close(); sql = await open(path); b = bind(sql, naive);
    await assert.rejects(b.service.qualify(b.ctx, intake, []), TrackBPendingError);
    assert.equal(naive.creates, 1); assert.equal(b.writes(), 0);
    naive.script = { ...naive.script, status: 'idle', stopReason: 'end_turn', structuredOutput: qualification, consumedMicroUsd: 190_003 };
    await b.service.qualify(b.ctx, intake, []);
    assert.deepEqual((await accounting(sql)).map(r => [r.consumed, r.settled]), [[190_003, '190003']]);
    await b.service.qualify(b.ctx, intake, []);
    assert.equal(naive.creates, 1); assert.deepEqual((await b.listJobCosts(job.jobId)).map(c => c.microUsd), [190_003]);
  } finally { await sql.engine.close(); }
}

export async function lostCostAcknowledgement(path: string) {
  let sql = await open(path, true);
  const naive = new LocalSessions();
  try {
    let b = bind(sql, naive, true);
    await assert.rejects(b.service.qualify(b.ctx, intake, []), /cost commit ACK lost/);
    assert.equal((await b.listJobCosts(job.jobId)).length, 1);
    await sql.engine.close(); sql = await open(path); b = bind(sql, naive);
    const polls = naive.polls;
    await b.service.qualify(b.ctx, intake, []);
    assert.equal(naive.creates, 1); assert.equal(naive.polls, polls);
    assert.deepEqual((await b.listJobCosts(job.jobId)).map(c => c.microUsd), [125_001]);
    assert.deepEqual((await accounting(sql)).map(r => r.settled), ['125001']);
  } finally { await sql.engine.close(); }
}

export async function reportSnapshotCharacterization(path: string) {
  const sql = await open(path, true);
  try {
    const b = bind(sql, new LocalSessions()); await b.service.qualify(b.ctx, intake, []);
    const costs = await b.listJobCosts(job.jobId);
    const report = renderReport({ job, generatedAt: time, costs, findings: [], limitations: ['Offline'], operatorSummary: null, includeHtml: true, evaluationStatus: 'unresolved', judgeUsage: { calls: 2, promptTokens: 11, completionTokens: 7 } });
    assert.equal(report.json.costs.knownMicroUsd, 125_001);
    assert.match(report.markdown, /\$0\.13/); assert.match(report.html!, /\$0\.13/);
    assert.match(report.json.costs.unknown.join(' '), /AI Gateway judge calls \(2/);
    assert.match(report.summary, /Evaluation incomplete/);
    const reread = await b.listJobCosts(job.jobId); reread[0].microUsd = 999_999;
    assert.equal(report.json.costs.entries[0].microUsd, 125_001); // SQL reads are detached.
    // The report retains a detached cost snapshot.
    costs[0].microUsd = 999_999;
    assert.equal(report.json.costs.entries[0].microUsd, 125_001);
    assert.equal(report.json.costs.knownMicroUsd, 125_001);
    assert.match(report.markdown, /\$0\.13/);
    assert.equal((await b.listJobCosts(job.jobId))[0].microUsd, 125_001);
  } finally { await sql.engine.close(); }
}

export async function blockedOperatorCosts(path: string, stopReason: 'budget_paused' | 'awaiting_input') {
  let sql = await open(path, true);
  const naive = new LocalSessions();
  try {
    naive.script = { ...naive.script, status: 'idle', stopReason, structuredOutput: null, consumedMicroUsd: 310_007 };
    let b = bind(sql, naive);
    if (stopReason === 'budget_paused') {
      await assert.rejects(b.service.renderReport(b.ctx, { intake, findings: [] }), e => e instanceof TrackBBlockedError && e.code === 'paused_budget');
    } else {
      // Current contract policy falls back for operator needs-input, but preserves its measured spend.
      const report = await b.service.renderReport(b.ctx, { intake, findings: [] });
      assert.match(report.markdown, /\$0\.31/);
    }
    assert.deepEqual((await b.listJobCosts(job.jobId)).map(c => c.microUsd), [310_007]);
    await sql.engine.close(); sql = await open(path); b = bind(sql, naive);
    const polls = naive.polls;
    if (stopReason === 'budget_paused') await assert.rejects(b.service.renderReport(b.ctx, { intake, findings: [] }), TrackBBlockedError);
    else await b.service.renderReport(b.ctx, { intake, findings: [] });
    assert.equal(naive.creates, 1); assert.equal(naive.polls, polls);
    assert.deepEqual((await accounting(sql)).map(r => [r.consumed, r.settled]), [[310_007, '310007']]);
    assert.equal((await b.listJobCosts(job.jobId)).length, 1);
  } finally { await sql.engine.close(); }
}

import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { AgentSessionService } from '../../../../packages/core/src/agents/session-service.js';
import { PostgresAgentTaskStore, PostgresBudgetLedger, type AgentTransactionalSql } from '../../../../packages/core/src/agents/postgres-ports.js';
import { harness } from '../../../../packages/core/src/agents/__tests__/fakes.js';
import { makeScenarios } from '../../../../packages/core/src/evals/text/__tests__/fixtures.js';
import { canonicalJson } from '../../../../packages/core/src/evals/text/freeze.js';
import { PostgresTextCheckpointStore } from '../../../../packages/core/src/evals/integration/checkpoints.js';
import { createTextEvaluationServices } from '../../../../packages/core/src/evals/integration/services.js';
import type { CostEntry, JobRef } from '../../../../packages/core/src/evals/types.js';
import type { ServiceContext } from '../../../../packages/core/src/contracts/services.js';
import { renderReport } from '../../../../packages/core/src/reporting/render.js';
import { createDurableProgressProjection, createDurableProgressReader } from '../../../../packages/core/src/reporting/chat/projection/index.js';
import type { ProjectionPlan } from '../../../../packages/core/src/reporting/chat/projection/types.js';
import { createPostgresConversationPort } from '../../../../packages/core/src/reporting/chat/postgres-conversations.js';
import { createProgressChatService } from '../../../../packages/core/src/reporting/chat/service.js';
import type { ProgressSnapshot } from '../../../../packages/core/src/reporting/chat/types.js';

const job: JobRef = { jobId: 'text-cross-service', customerId: 'local-owner', package: 'text_eval', environment: 'test', quoteVersion: null, linkedRetestOf: null, isFixture: true };
const scope = { subjectId: 'owner', jobId: job.jobId };
const root = new URL('../../../../packages/core/src/', import.meta.url);

/** Actual SQL adapters and production factories; only external target/Naive are local fixtures. */
async function fixture() {
  const path = await mkdtemp(join(tmpdir(), 'text-release-db-'));
  let engine = new PGlite(path);
  for (const file of ['agents/persistence-migrations/001-agent-persistence.sql', 'evals/integration/migrations/001-text-integration.sql', 'reporting/chat/persistence-migrations/001-conversations.sql']) {
    await engine.exec(await readFile(new URL(file, root), 'utf8'));
  }
  await engine.exec(`CREATE TABLE release_job (job_id text PRIMARY KEY, status text NOT NULL, at text NOT NULL)`);
  await engine.query('INSERT INTO release_job VALUES ($1, $2, $3)', [job.jobId, 'planning', '2026-11-07T20:00:00.000Z']);
  const db: AgentTransactionalSql = {
    query: <T>(sql: string, params?: unknown[]) => engine.query<T>(sql, params),
    transaction: fn => engine.transaction(tx => fn({ query: <T>(sql: string, params?: unknown[]) => tx.query<T>(sql, params) })),
  };
  const h = harness(body => ({
    pollsUntilDone: body.metadata.ae_output === 'text_investigation' ? 65 : 0,
    structuredOutput: body.metadata.ae_output === 'text_design' ? { scenarios: makeScenarios() }
      : body.metadata.ae_output === 'text_review' ? { verdicts: makeScenarios().map(s => ({ scenarioId: s.id, accepted: true, reasons: [] })) }
      : { reproduceScenarioIds: ['S01'], verdicts: [{ candidateId: 'text:S01:S01.o1', verdict: 'confirmed', rationale: 'The required marker is absent on both attempts.', quote: 'WRONG_PRIVATE_RESPONSE', defectNote: null }] },
  }), { store: new PostgresAgentTaskStore(db), ledger: new PostgresBudgetLedger(db) });
  let sends = 0;
  const target = { async send() { sends++; return { ok: true as const, text: 'WRONG_PRIVATE_RESPONSE', latencyMs: 1 }; } };
  // The application cost sink is outside this task: compare durable authoritative cost checkpoints.
  const ctx: ServiceContext = { jobId: job.jobId, environment: 'test', budgetMicroUsd: 1_000_000, recordCost: async () => {}, recordProgress: async () => {} };
  const api = () => createTextEvaluationServices({
    runner: new AgentSessionService({ ...h.deps, workerId: 'fresh-worker', store: new PostgresAgentTaskStore(db), ledger: new PostgresBudgetLedger(db) }),
    checkpoints: new PostgresTextCheckpointStore(db), clock: h.clock,
    resolve: async () => ({ job, target, targetVersion: 'local-v1', judge: null }),
  });
  const design = await api().designSuite(ctx, { suiteId: 'release-suite', versionLabel: 'v1', systemPrompt: null, referenceText: null });
  assert.equal(design.status, 'completed');
  if (design.status !== 'completed') throw new Error('design failed');
  const request = { suiteDigest: design.suite.digest, runId: 'baseline', scenarioIds: ['S01'] };
  const access = {
    authenticate: async () => ({ subjectId: scope.subjectId }),
    resolveAuthorizedJob: async (caller: { subjectId: string }, id: string) => caller.subjectId === scope.subjectId && id === job.jobId ? scope : null,
  };
  async function plan(sql = db): Promise<ProjectionPlan> {
    const rows = await sql.query<{ kind: string; id: string; input_digest: string }>(`SELECT kind, id, input_digest FROM text_integration.checkpoints WHERE job_id=$1 AND kind IN ('design','run_result','investigation') ORDER BY kind`, [job.jobId]);
    // Inventory includes a planned result even while its scenarios/target are fenced in flight.
    if (!rows.rows.some(row => row.kind === 'run_result')) {
      const identity = (await sql.query<{ id: string; input_digest: string }>("SELECT id,input_digest FROM text_integration.checkpoints WHERE job_id=$1 AND kind='run_identity'", [job.jobId])).rows[0];
      if (identity) rows.rows.push({ ...identity, kind: 'run_result' });
    }
    return { scope, environment: 'test', acquisitionTaskIds: [], checkpoints: rows.rows.map(row => ({
      key: { jobId: job.jobId, kind: row.kind, id: row.id, inputDigest: row.input_digest },
      format: row.kind === 'design' ? 'text_design' : row.kind === 'run_result' ? 'text_run' : 'text_investigation',
      phase: row.kind === 'design' ? 'planning' : row.kind === 'run_result' ? 'running' : 'investigating',
      suiteDigest: request.suiteDigest, runId: request.runId, scenarioIds: request.scenarioIds,
    })) };
  }
  const projection = () => createDurableProgressProjection({ access, resolve: () => plan(), referenceKey: 'local-fixture-reference-key-over-32-bytes', reader: createDurableProgressReader({
    // One PGlite transaction pins all reads; the local inventory is checked inside it.
    withRead: (inventory, read) => db.transaction(async tx => {
      assert.deepEqual(await plan(tx as AgentTransactionalSql), inventory);
      const fact = (await tx.query<{ status: ProgressSnapshot['status']; at: string }>('SELECT status, at FROM release_job WHERE job_id=$1', [inventory.scope.jobId])).rows[0]!;
      const costs = (await tx.query<{ value: CostEntry }>("SELECT value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='cost' AND state='completed'", [inventory.scope.jobId])).rows.map(r => r.value);
      return read({ observedAt: fact.at, job: { jobId: job.jobId, status: fact.status, updatedAt: fact.at }, costs, unknownCosts: true, checkpoints: new PostgresTextCheckpointStore(tx as AgentTransactionalSql), acquisition: { get: async () => { throw new Error('no acquisition planned'); } } });
    }),
  }) });
  const chat = () => createProgressChatService({ access, progress: projection(), conversations: createPostgresConversationPort(db) });
  async function mark(status: ProgressSnapshot['status']) { await db.query('UPDATE release_job SET status=$2, at=$3 WHERE job_id=$1', [job.jobId, status, h.clock.now().toISOString()]); }
  return { api, ctx, request, h, db, chat, projection, mark, sends: () => sends,
    restart: async () => { await engine.close(); engine = new PGlite(path); await engine.waitReady; },
    close: async () => { await engine.close(); await rm(path, { recursive: true, force: true }); },
  };
}

/** Acceptance: pending is not reportable; resumed evidence agrees across SQL/report/private chat. */
export async function textPendingRestartConsistency() {
  const f = await fixture();
  try {
    const run = await f.api().runSuite(f.ctx, f.request);
    assert.equal(run.executions[0]!.checks[0]!.status, 'fail');
    const pending = await f.api().investigate(f.ctx, f.request);
    assert.equal(pending.investigatorStatus, 'pending');
    assert.equal(pending.findings[0]!.label, 'inconclusive');
    await f.mark('investigating');
    await assert.rejects(f.api().reportInput(f.ctx, f.request), { name: 'TrackBPendingError' });
    const before = await f.projection().project(scope);
    assert.equal(before.snapshot.findings.length, 0); // Provisional return is not a saved investigation.
    assert.equal(before.phases.find(p => p.phase === 'investigating')!.state, 'pending');
    const early = await f.chat().send({ jobId: job.jobId, messageId: 'early', question: 'findings' });
    assert.match(early.reply.text, /0 total; 0 confirmed/);
    assert.match(early.reply.unknowns.join(' '), /zero recorded findings does not establish absence/);
    const creates = f.h.naive.createCalls.length;
    assert.equal(creates, 3);
    await f.restart(); // Reopen file-backed DB and recreate production services/adapters.
    const investigation = await f.api().investigate(f.ctx, f.request);
    assert.equal(investigation.investigatorStatus, 'completed');
    assert.equal(investigation.findings.length, 1);
    assert.equal(investigation.findings[0]!.label, 'confirmed');
    assert.equal(investigation.reproductions.length, 1);
    assert.notEqual(investigation.reproductions[0]!.runId, run.runId);
    assert.equal(f.sends(), 2);
    assert.equal(f.h.naive.createCalls.length, creates); // Same durable investigator session resumed.
    const reportInput = await f.api().reportInput(f.ctx, f.request);
    assert.deepEqual(reportInput.run, run);
    assert.deepEqual(reportInput.richFindings, investigation.findings);
    const costs = (await f.db.query<{ value: CostEntry }>("SELECT value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='cost'", [job.jobId])).rows.map(r => r.value);
    const report = renderReport({ job, generatedAt: f.h.clock.now().toISOString(), findings: reportInput.richFindings, limitations: reportInput.limitations, operatorSummary: null, costs, evaluationStatus: 'completed', includeHtml: true });
    assert.equal(report.json.summary.counts.confirmed, 1);
    assert.equal(report.json.summary.counts.inconclusive, 0);
    assert.ok(report.markdown.includes('WRONG_PRIVATE_RESPONSE'));
    await f.mark('delivered');
    const projected = await f.projection().project(scope);
    assert.deepEqual(projected.snapshot.findings.map(f => f.status), ['confirmed']);
    assert.equal(projected.snapshot.blockers.length, 0);
    assert.equal(projected.snapshot.costs.reduce((n, c) => n + c.microUsd, 0), report.json.costs.knownMicroUsd);
    assert.equal(projected.snapshot.costs.length, 3);
    const late = await f.chat().send({ jobId: job.jobId, messageId: 'late', question: 'findings' });
    assert.match(late.reply.text, /1 total; 1 confirmed, 0 rubric concern\(s\), 0 inconclusive/);
    assert.ok(!JSON.stringify(late).includes('WRONG_PRIVATE_RESPONSE'));
    assert.ok(!JSON.stringify(late).includes('S01.o1'));
    const poll = await f.chat().poll({ jobId: job.jobId });
    const cursor = poll.cursor;
    await f.restart();
    assert.deepEqual(await f.api().runSuite(f.ctx, f.request), run);
    assert.deepEqual(await f.api().investigate(f.ctx, f.request), investigation);
    assert.deepEqual(await f.chat().send({ jobId: job.jobId, messageId: 'early', question: 'findings' }), early);
    assert.deepEqual((await f.chat().history({ jobId: job.jobId })).messages, [early, late]);
    assert.equal((await f.chat().poll({ jobId: job.jobId, cursor })).changed, false);
    assert.equal(f.sends(), 2);
    assert.equal(f.h.naive.createCalls.length, creates);
    // Negative control: corrupt durable association; strict projection must refuse it.
    await f.db.query("UPDATE text_integration.checkpoints SET value=jsonb_set(value,'{findings,0,reproduction,runId}',to_jsonb('foreign-run'::text)) WHERE job_id=$1 AND kind='investigation'", [job.jobId]);
    await assert.rejects(f.projection().project(scope), { code: 'invalid_snapshot' });
  } finally { await f.close(); }
}

/** Acceptance: a durable in-flight target fence survives worker/database restart without send. */
export async function textPendingTargetRestart() {
  const f = await fixture();
  try {
    const request = { runId: f.request.runId, scenarioId: 'S01', systemPrompt: null, userMessage: makeScenarios()[0]!.userMessage };
    // Use actual request shape from execute.ts; explicit target intent simulates crash before acknowledgement.
    const executionRequest = { ...request };
    const key = { jobId: job.jobId, kind: 'target', id: createHash('sha256').update(canonicalJson([request.runId, request.scenarioId])).digest('hex'), inputDigest: createHash('sha256').update(canonicalJson({ environment: 'test', input: { suiteDigest: f.request.suiteDigest, targetVersion: 'local-v1', scope: 'initial', request: executionRequest } })).digest('hex') };
    await new PostgresTextCheckpointStore(f.db).claim(key);
    await f.restart();
    await assert.rejects(f.api().runSuite(f.ctx, f.request), { name: 'TrackBPendingError' });
    assert.equal(f.sends(), 0);
    await f.mark('running');
    const progress = await f.projection().project(scope);
    assert.equal(progress.phases.find(p => p.phase === 'running')!.state, 'missing');
    assert.equal(progress.snapshot.findings.length, 0);
    assert.equal(progress.snapshot.status, 'running');
    await assert.rejects(f.api().reportInput(f.ctx, f.request));
    await f.restart();
    await assert.rejects(f.api().runSuite(f.ctx, f.request), { name: 'TrackBPendingError' });
    assert.equal(f.sends(), 0);
  } finally { await f.close(); }
}

/** Current adapters + actual rich engine and SQL stores. Only provider/target transport are fakes. */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntakeInput } from '../contracts';
import type { ServiceContext } from '../contracts/services';
import { PostgresAgentTaskStore, PostgresBudgetLedger, type AgentTransactionalSql } from '../agents/postgres-ports';
import { AgentSessionService } from '../agents/session-service';
import { harness } from '../agents/__tests__/fakes';
import { makeScenarios } from './text/__tests__/fixtures';
import { createTextEvaluationServices } from './integration/services';
import { PostgresTextCheckpointStore } from './integration/checkpoints';
import { createNaiveArtifactStore } from './naive-artifact-store';
import { createNaiveDesignService, type NaiveTextDesignIdentity } from './naive-design-service';
import { createNaiveRunService } from './naive-run-service';
import { createNaiveInvestigationService } from './naive-investigation-service';
import type { JobRef } from './types';

const open: PGlite[] = [];
afterEach(async () => { for (const db of open.splice(0)) await db.close(); });
async function setup() {
  const pg = new PGlite(); open.push(pg);
  await pg.exec(readFileSync(new URL('../agents/persistence-migrations/001-agent-persistence.sql', import.meta.url), 'utf8'));
  await pg.exec(readFileSync(new URL('./integration/migrations/001-text-integration.sql', import.meta.url), 'utf8'));
  await pg.exec('CREATE TABLE fixture_owner(job_id text PRIMARY KEY, customer_id text NOT NULL, active boolean NOT NULL); CREATE TABLE fixture_cost(receipt_key text PRIMARY KEY, receipt jsonb NOT NULL)');
  const sql: AgentTransactionalSql = {
    query: (q, p) => pg.query(q, p), transaction: fn => pg.transaction(tx => fn({ query: (q, p) => tx.query(q, p) })),
  };
  const job: JobRef = { jobId: '123e4567-e89b-42d3-a456-426614174000', customerId: 'runtime-customer', package: 'text_eval', environment: 'test', quoteVersion: null, linkedRetestOf: null, isFixture: true };
  await sql.query('INSERT INTO fixture_owner VALUES ($1,$2,true)', [job.jobId, job.customerId]);
  const intake: Extract<IntakeInput, { package: 'text_eval' }> = { package: 'text_eval', authorizedToTest: true, endpoint: { url: 'https://fixture.invalid/v1', model: 'fixture', systemPrompt: 'Follow explicit constraints.' } };
  const provider = harness(body => ({ structuredOutput: body.metadata.ae_output === 'text_design' ? { scenarios: makeScenarios() }
    : body.metadata.ae_output === 'text_review' ? { verdicts: makeScenarios().map(s => ({ scenarioId: s.id, accepted: true, reasons: [] })) }
    : { reproduceScenarioIds: ['S01'], verdicts: [{ candidateId: 'text:S01:S01.o1', verdict: 'confirmed', rationale: 'Reproduced the exact constraint failure.', quote: 'WRONG', defectNote: null }] },
  }), { store: new PostgresAgentTaskStore(sql), ledger: new PostgresBudgetLedger(sql) });
  const send = vi.fn(async () => ({ ok: true as const, text: 'WRONG', latencyMs: 1 }));
  let designIdentity: NaiveTextDesignIdentity | undefined;
  let loseCostAck = false, loseRunAck = false;
  const ctx: ServiceContext = { jobId: job.jobId, environment: 'test', budgetMicroUsd: 1_000_000, recordProgress: async () => {},
    async recordCost(cost) {
      const key = String(cost.meta?.idempotencyKey);
      await sql.transaction(async tx => {
        await tx.query('INSERT INTO fixture_cost VALUES ($1,$2::jsonb) ON CONFLICT DO NOTHING', [key, JSON.stringify(cost)]);
        const check = await tx.query<{ equal: boolean }>('SELECT receipt = $2::jsonb AS equal FROM fixture_cost WHERE receipt_key=$1', [key, JSON.stringify(cost)]);
        if (!check.rows[0]?.equal) throw Error('fixture_cost_conflict');
      });
      if (loseCostAck) { loseCostAck = false; throw Error('cost_ack_lost'); }
    },
  };
  const authorize = async (tx: Pick<AgentTransactionalSql, 'query'>, scope: { jobId: string; customerId: string; environment: string }) => {
    const r = await tx.query<{ active: boolean }>('SELECT active FROM fixture_owner WHERE job_id=$1 AND customer_id=$2', [scope.jobId, scope.customerId]);
    if (!r.rows[0]?.active || scope.environment !== 'test') throw Error('scope_denied');
    return { knownSecrets: [] as string[] };
  };
  function runtime() {
    const artifacts = createNaiveArtifactStore({ sql, authorize, decide: async (_tx, identity, _suite) => {
      designIdentity = structuredClone(identity);
      return { status: 'approved' as const, approvalArtifactId: 'fixture-reviewed-admission-1' };
    } });
    const checkpoints = new PostgresTextCheckpointStore(sql);
    const runner = new AgentSessionService({ ...provider.deps, workerId: 'restart', store: new PostgresAgentTaskStore(sql), ledger: new PostgresBudgetLedger(sql) });
    const resolve = async () => { await authorize(sql, job); return { job, target: { send }, targetVersion: 'target-v1', judge: null, knownSecrets: [] }; };
    const rich = createTextEvaluationServices({ runner, checkpoints, resolve, clock: provider.clock });
    const design = createNaiveDesignService({ engine: rich, admission: artifacts.admission, authorize: async () => {
      await authorize(sql, job); return { job, intake, designId: 'primary', versionLabel: 'v1', knownSecrets: [] };
    } });
    async function retained() {
      if (!designIdentity) throw Error('missing_design');
      const admission = await artifacts.admission.load(designIdentity);
      if (admission?.status !== 'approved') throw Error('missing_admission');
      return admission.artifact;
    }
    const run = createNaiveRunService({ runner, checkpoints, clock: provider.clock, persistRun: async (...args) => { await artifacts.persistRun(...args); if (loseRunAck) { loseRunAck = false; throw Error('run_ack_lost'); } },
      resolve: async () => { const artifact = await retained(); return { ...await resolve(), scope: artifact.scope, retained: artifact, canonicalTarget: intake.endpoint, runId: 'baseline' }; } });
    const investigate = createNaiveInvestigationService({ runner, checkpoints, clock: provider.clock, persistInvestigation: artifacts.persistInvestigation,
      resolve: async () => { const suite = await retained(); const run = await artifacts.loadRun(ctx, suite.scope, 'baseline', 'target-v1');
        if (!run) throw Error('missing_run'); return { ...await resolve(), scope: suite.scope, retainedSuite: suite, retainedRun: run }; } });
    return { ...design, ...run, ...investigate, artifacts, retained };
  }
  return { pg, sql, job, ctx, intake, provider, send, runtime, loseNextCostAck() { loseCostAck = true; }, loseNextRunAck() { loseRunAck = true; } };
}
describe('current Naive runtime integration with SQL authority artifacts', () => {
  it('designs, admits, executes and investigates through concrete adapters; new instances replay without redispatch', async () => {
    const f = await setup(); const api = f.runtime();
    const suite = await api.designSuite(f.ctx, f.intake);
    const run = await api.runSuite(f.ctx, suite, f.intake.endpoint);
    const findings = await api.investigate(f.ctx, suite, [run]);
    expect(findings.find(x => x.id === 'text:S01:S01.o1')?.status).toBe('confirmed');
    expect(f.provider.naive.createCalls).toHaveLength(3); expect(f.send).toHaveBeenCalledTimes(13);
    const restarted = f.runtime();
    expect(await restarted.designSuite(f.ctx, f.intake)).toEqual(suite);
    expect(await restarted.runSuite(f.ctx, suite, f.intake.endpoint)).toEqual(run);
    expect(await restarted.investigate(f.ctx, suite, [run])).toEqual(findings);
    expect(f.provider.naive.createCalls).toHaveLength(3); expect(f.send).toHaveBeenCalledTimes(13);
    expect((await f.sql.query<{ count: number }>('SELECT count(*)::int AS count FROM fixture_cost')).rows[0]?.count).toBe(3);
  }, 30_000);
  it('recovers a SQL cost commit with lost acknowledgement without additional provider session creation', async () => {
    const f = await setup(); f.loseNextCostAck();
    await expect(f.runtime().designSuite(f.ctx, f.intake)).rejects.toThrow('cost_ack_lost');
    const calls = f.provider.naive.createCalls.length;
    const suite = await f.runtime().designSuite(f.ctx, f.intake);
    expect(suite.scenarios).toHaveLength(12); expect(f.provider.naive.createCalls).toHaveLength(calls);
    expect((await f.sql.query<{ count: number }>('SELECT count(*)::int AS count FROM fixture_cost')).rows[0]?.count).toBe(2);
  }, 30_000);
  it('recovers committed rich artifact publication after lost acknowledgement without redispatch', async () => {
    const f = await setup(); const suite = await f.runtime().designSuite(f.ctx, f.intake); f.loseNextRunAck();
    await expect(f.runtime().runSuite(f.ctx, suite, f.intake.endpoint)).rejects.toThrow('run_ack_lost');
    const result = await f.runtime().runSuite(f.ctx, suite, f.intake.endpoint);
    expect(result.results).toHaveLength(12); expect(f.send).toHaveBeenCalledTimes(12);
    expect(f.provider.naive.createCalls).toHaveLength(2);
  }, 30_000);
  it('revokes owner scope in SQL and refuses retained publication or target dispatch after restart', async () => {
    const f = await setup(); const suite = await f.runtime().designSuite(f.ctx, f.intake);
    await f.sql.query('UPDATE fixture_owner SET active=false WHERE job_id=$1', [f.job.jobId]);
    await expect(f.runtime().designSuite(f.ctx, f.intake)).rejects.toThrow();
    await expect(f.runtime().runSuite(f.ctx, suite, f.intake.endpoint)).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled(); expect(f.provider.naive.createCalls).toHaveLength(2);
  }, 30_000);
});

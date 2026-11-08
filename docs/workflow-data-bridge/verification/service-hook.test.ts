import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { createTextEvaluationServices } from '@ae/core/evals/integration/services';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import { createApprovedSuiteAdmission } from '@ae/core/evals/integration/approved-suite';
import { fixtureJob, fixtureTask } from '@ae/core/evals/data/adapters/fixtures';
import { frozenDataReference, mapApprovedDataToTextDesign } from '@ae/core/evals/data/adapters/mapping';
import { makeSuite } from '@ae/core/evals/text/__tests__/fixtures';
import type { ServiceContext } from '@ae/core/contracts/services';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';

it('actual patched service executes retained approved suite through SQL and reports without design/refreeze/checkpoint fabrication', async () => {
  const engine = new PGlite();
  try {
    await engine.exec(readFileSync(join(process.env.BRIDGE_STAGE!, 'packages/core/src/evals/integration/migrations/001-text-integration.sql'), 'utf8'));
    const db: AgentTransactionalSql = { query: (sql, values) => engine.query(sql, values), transaction: fn => engine.transaction(tx => fn({ query: (sql, values) => tx.query(sql, values) })) };
    const task = fixtureTask();
    const context = { versionLabel: 'fixture-v1', systemPrompt: null };
    const mapping = mapApprovedDataToTextDesign(task, { job: fixtureJob, ...context });
    if (mapping.status !== 'ready') throw new Error(mapping.reason);
    const suite = makeSuite({ jobId: fixtureJob.jobId, systemPrompt: null, referenceText: mapping.designInput.referenceText });
    const frozen = { suite, provenance: frozenDataReference(task, suite, { job: fixtureJob, ...context }).provenance };
    const result = { status: 'ready' as const, task, frozen, progress: { outcome: 'ready' as const, factualCorrectness: 'assessed' as const, message: 'fixture only' } };
    const admission = createApprovedSuiteAdmission({ resolve: async () => ({ job: fixtureJob, context, result }) });
    const ctx: ServiceContext = { jobId: fixtureJob.jobId, environment: 'test', budgetMicroUsd: 1_000_000, recordCost: async () => {}, recordProgress: async () => {} };
    const runner = { run: vi.fn(async (): Promise<never> => { throw new Error('No design or provider authority in this regression'); }) };
    const send = vi.fn(async () => ({ ok: true as const, text: 'READY', latencyMs: 1 }));
    const restart = () => createTextEvaluationServices({ runner, checkpoints: new PostgresTextCheckpointStore(db), resolveApprovedSuite: admission.resolveApprovedSuite,
      resolve: async () => ({ job: fixtureJob, targetVersion: 'approved-target-v1', target: { send }, judge: null }) });
    expect(await restart().getSuite(ctx, suite.digest)).toEqual(suite);
    const input = { suiteDigest: suite.digest, runId: 'approved-baseline' };
    const run = await restart().runSuite(ctx, input);
    expect(run.executions).toHaveLength(12);
    const investigation = await restart().investigate(ctx, input);
    expect(investigation.investigatorStatus).toBe('skipped');
    const report = await restart().reportInput(ctx, input);
    expect(report.suite).toEqual(suite);
    expect(report.run).toEqual(run);
    expect(await admission.get(ctx, suite.digest)).toEqual(frozen);
    expect(await restart().runSuite(ctx, input)).toEqual(run);
    expect(send).toHaveBeenCalledTimes(12);
    expect(runner.run).not.toHaveBeenCalled();
    // Only factory-owned run/investigation/target checkpoints were written.
    const stored = await engine.query<{ kind: string }>('SELECT DISTINCT kind FROM text_integration.checkpoints');
    expect(stored.rows.map(row => row.kind)).not.toContain('suite');
  } finally { await engine.close(); }
});

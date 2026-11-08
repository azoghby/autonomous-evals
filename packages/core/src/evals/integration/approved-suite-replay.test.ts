import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it, vi } from 'vitest';
import { createTextEvaluationServices } from './services';
import { PostgresTextCheckpointStore } from './checkpoints';
import { createApprovedSuiteAdmission } from './approved-suite';
import { fixtureJob, fixtureTask } from '../data/adapters/fixtures';
import { frozenDataReference, mapApprovedDataToTextDesign } from '../data/adapters/mapping';
import { makeSuite } from '../text/__tests__/fixtures';
import type { ServiceContext } from '../../contracts/services';
import type { AgentTransactionalSql } from '../../agents/postgres-ports';

it('service executes retained approved suite through SQL and reports without design/refreeze/checkpoint fabrication', async () => {
  const engine = new PGlite();
  try {
    await engine.exec(readFileSync(new URL('./migrations/001-text-integration.sql', import.meta.url), 'utf8'));
    const db: AgentTransactionalSql = { query: (sql, values) => engine.query(sql, values), transaction: fn => engine.transaction(tx => fn({ query: (sql, values) => tx.query(sql, values) })) };
    const task = fixtureTask();
    const context = { versionLabel: 'fixture-v1', systemPrompt: null };
    const mapping = mapApprovedDataToTextDesign(task, { job: fixtureJob, ...context });
    if (mapping.status !== 'ready') throw new Error(mapping.reason);
    const suite = makeSuite({ jobId: fixtureJob.jobId, systemPrompt: null, referenceText: mapping.designInput.referenceText });
    const frozen = { suite, provenance: frozenDataReference(task, suite, { job: fixtureJob, ...context }).provenance };
    const result = { status: 'ready' as const, task, frozen, progress: { outcome: 'ready' as const, factualCorrectness: 'assessed' as const, message: 'fixture only' } };
    let authorized = true;
    const admission = createApprovedSuiteAdmission({ resolve: async () => {
      if (!authorized) throw new Error('authorization_revoked');
      return { job: fixtureJob, context, result };
    } });
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
    // Durable results never bypass current approved-data authorization on replay.
    authorized = false;
    await expect(restart().getSuite(ctx, suite.digest)).rejects.toThrow('authorization_revoked');
    await expect(restart().runSuite(ctx, input)).rejects.toThrow('authorization_revoked');
    await expect(restart().investigate(ctx, input)).rejects.toThrow('authorization_revoked');
    await expect(restart().reportInput(ctx, input)).rejects.toThrow('authorization_revoked');
    expect(send).toHaveBeenCalledTimes(12);
    expect(runner.run).not.toHaveBeenCalled();
  } finally { await engine.close(); }
});

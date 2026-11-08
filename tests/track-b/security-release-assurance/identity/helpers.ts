import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { AgentTransactionalSql } from '../../../../packages/core/src/agents/postgres-ports';
import { PostgresTextCheckpointStore } from '../../../../packages/core/src/evals/integration/checkpoints';
import { createDurableProgressProjection, createDurableProgressReader } from '../../../../packages/core/src/reporting/chat/projection/index';
import type { ProjectionPlan } from '../../../../packages/core/src/reporting/chat/projection/types';
export const time = '2026-11-07T20:00:00.000Z';
export const scope = { subjectId: 'human', jobId: 'identity-job' };
export const digestA = 'a'.repeat(64), digestB = 'b'.repeat(64);
export async function database() {
  const engine = new PGlite();
  for (const path of ['evals/integration/migrations/001-text-integration.sql', 'evals/data/persistence-migrations/001-evaluation-data.sql']) {
    await engine.exec(readFileSync(new URL('../../../../packages/core/src/' + path, import.meta.url), 'utf8'));
  }
  const db: AgentTransactionalSql = {
    query: (sql, params) => engine.query(sql, params),
    transaction: fn => engine.transaction(tx => fn({ query: (sql, params) => tx.query(sql, params) })),
  };
  return { engine, db, store: new PostgresTextCheckpointStore(db) };
}
export function plan(): ProjectionPlan {
  return { scope: { ...scope }, environment: 'test', acquisitionTaskIds: [], checkpoints: [{
    key: { jobId: scope.jobId, kind: 'run_result', id: 'run', inputDigest: digestA },
    format: 'text_run', phase: 'running', runId: 'run', suiteDigest: digestA, scenarioIds: ['S01'],
  }] };
}
export function runValue(environment: 'test' | 'live'): { environment: 'test' | 'live'; run: import('../../../../packages/core/src/evals/text/schema').SuiteRun } {
  return { environment, run: { schemaVersion: 'text_run.v1', jobId: scope.jobId, runId: 'run', suiteDigest: digestA,
    versionLabel: 'v1', startedAt: time, completedAt: time, executions: [{
      scenarioId: 'S01', runId: 'run', attempt: 'initial', startedAt: time, completedAt: time,
      outcome: 'completed', target: { ok: true, errorCode: null, latencyMs: 1 }, responseText: 'READY', responseClipped: false, checks: [],
    }] } };
}
export function projector(p: ProjectionPlan, checkpoints: { get: PostgresTextCheckpointStore['get'] }, acquisition = { get: async (_id: string) => null as import('../../../../packages/core/src/evals/data/acquisition').EvaluationDataTask | null }, duringRead = () => {}) {
  return createDurableProgressProjection({
    referenceKey: 'local-identity-test-reference-key-32-bytes',
    access: { authenticate: async () => ({ subjectId: scope.subjectId }), resolveAuthorizedJob: async () => ({ ...scope }) },
    resolve: async () => p,
    reader: createDurableProgressReader({ withRead: async (_plan, read) => {
      duringRead();
      return read({ observedAt: time, job: { jobId: scope.jobId, status: 'running', updatedAt: time }, costs: [], unknownCosts: true, checkpoints, acquisition });
    } }),
  });
}
export async function save(store: PostgresTextCheckpointStore, key: ProjectionPlan['checkpoints'][number]['key'], value: unknown) {
  const claimed = await store.claim(key);
  if (claimed.state !== 'claimed') throw new Error('expected unique checkpoint');
  await store.complete(key, claimed.token, value);
}

import 'server-only';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { reviewDigest } from '@ae/core/evals/data/binding';
import { inspectDataSafety } from '@ae/core/evals/data/quality';
import type { DataOrchestrationResult } from '@ae/core/evals/data/orchestration';
import { TrackBBlockedError } from '@ae/core/evals/service-adapter';
import { advanceProductionData, type ProductionDataInput } from './data-production';

type Scope = { tenantId: string; jobId: string; environment: 'test' | 'live'; workflowRunId: string };
const refuse = (): never => { throw new TrackBBlockedError('needs_operator', 'Data plan authority or immutable identity requires reconciliation.'); };
async function authorize(sql: AgentTransactionalSql, scope: Scope) {
  const row = await sql.query('SELECT id FROM jobs WHERE id=$1 AND customer_id=$2 AND environment=$3 AND workflow_run_id=$4 AND package=$5 AND is_mock=false AND state IN ($6,$7,$8)',
    [scope.jobId, scope.tenantId, scope.environment, scope.workflowRunId, 'text_eval', 'planning', 'running', 'investigating']);
  if (row.rows.length !== 1) refuse();
}
/** Private trusted producer capability. Owner must supply a durable authorized plan;
 * no route, model output or default fixture grants this authority. */
export async function registerWorkflowDataPlan(sql: AgentTransactionalSql, scope: Scope, input: ProductionDataInput, knownSecrets: readonly string[]) {
  input = structuredClone(input);
  if (input.task.jobId !== scope.jobId || !/^[A-Za-z0-9_-]{1,96}$/.test(input.task.taskId) || !inspectDataSafety(input, knownSecrets).safe) refuse();
  await authorize(sql, scope);
  const result = await sql.query(`INSERT INTO workflow_integration.data_plans(job_id,tenant_id,environment,input_digest,input)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(job_id) DO UPDATE SET job_id=EXCLUDED.job_id
    WHERE workflow_integration.data_plans.tenant_id=EXCLUDED.tenant_id AND workflow_integration.data_plans.environment=EXCLUDED.environment
      AND workflow_integration.data_plans.input_digest=EXCLUDED.input_digest AND workflow_integration.data_plans.input=EXCLUDED.input RETURNING job_id`,
    [scope.jobId, scope.tenantId, scope.environment, reviewDigest(input), JSON.stringify(input)]);
  if (result.rows.length !== 1) refuse();
}
export async function readWorkflowDataPlan(sql: AgentTransactionalSql, scope: Scope, knownSecrets: readonly string[]) {
  await authorize(sql, scope);
  const row = (await sql.query<{ input: ProductionDataInput; input_digest: string }>(
    'SELECT input,input_digest FROM workflow_integration.data_plans WHERE job_id=$1 AND tenant_id=$2 AND environment=$3', [scope.jobId, scope.tenantId, scope.environment])).rows[0];
  if (!row) return null;
  if (reviewDigest(row.input) !== row.input_digest || row.input.task.jobId !== scope.jobId || !inspectDataSafety(row.input, knownSecrets).safe) refuse();
  return row.input;
}
export async function readWorkflowDataReady(sql: AgentTransactionalSql, scope: Scope, knownSecrets: readonly string[]) {
  const input = await readWorkflowDataPlan(sql, scope, knownSecrets);
  if (!input) return null;
  const row = (await sql.query<{ result: DataOrchestrationResult; result_digest: string }>(
    'SELECT result,result_digest FROM workflow_integration.data_ready WHERE job_id=$1 AND input_digest=$2', [scope.jobId, reviewDigest(input)])).rows[0];
  if (!row) return null;
  if (reviewDigest(row.result) !== row.result_digest || row.result.status !== 'ready' || !row.result.frozen
    || reviewDigest(row.result.task.spec) !== reviewDigest(input.task) || !inspectDataSafety(row.result, knownSecrets).safe) refuse();
  return { input, result: row.result };
}
/** Inventory publication MUST commit before advance can dispatch. Every nonready
 * status is retained privately and returned verbatim; no state is converted to success. */
export async function advanceWorkflowData(sql: AgentTransactionalSql, scope: Scope, knownSecrets: readonly string[], inventory: { acquisition(ids: string[]): Promise<void>; touch(): Promise<void> }, dispatch: typeof advanceProductionData = advanceProductionData) {
  const input = await readWorkflowDataPlan(sql, scope, knownSecrets);
  const tasks = await sql.query<{ task_id: string }>('SELECT task_id FROM evaluation_data_persistence.tasks WHERE tenant_id=$1 AND job_id=$2 ORDER BY task_id', [scope.tenantId, scope.jobId]);
  const ids = [...new Set([...tasks.rows.map(row => row.task_id), ...(input ? [input.task.taskId] : [])])];
  if (ids.length) await inventory.acquisition(ids);
  if (!input) { if (ids.length) refuse(); return null; }
  if (ids.some(id => id !== input.task.taskId)) refuse(); // Multiple suites require a separate authorized composition.
  const ready = await readWorkflowDataReady(sql, scope, knownSecrets);
  if (ready) { await inventory.touch(); return ready.result; }
  let result: DataOrchestrationResult;
  try { result = await dispatch(scope.jobId, input); }
  finally { await inventory.touch(); } // Includes review/claim/cost writes even on failure.
  if (reviewDigest(result.task.spec) !== reviewDigest(input.task) || !inspectDataSafety(result, knownSecrets).safe) refuse();
  const digest = reviewDigest(result);
  // Keep every distinct pending/review/cost snapshot; ready is a separate immutable binding.
  await sql.query(`INSERT INTO workflow_integration.data_advances(job_id,result_digest,result) VALUES($1,$2,$3::jsonb) ON CONFLICT(job_id,result_digest) DO NOTHING`, [scope.jobId, digest, JSON.stringify(result)]);
  if (result.status === 'ready') {
    if (!result.frozen) refuse();
    const saved = await sql.query(`INSERT INTO workflow_integration.data_ready(job_id,input_digest,result_digest,result) VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(job_id) DO UPDATE SET job_id=EXCLUDED.job_id WHERE workflow_integration.data_ready.input_digest=EXCLUDED.input_digest
      AND workflow_integration.data_ready.result_digest=EXCLUDED.result_digest AND workflow_integration.data_ready.result=EXCLUDED.result RETURNING job_id`,
      [scope.jobId, reviewDigest(input), digest, JSON.stringify(result)]);
    if (saved.rows.length !== 1) refuse();
  }
  await inventory.touch();
  return result;
}

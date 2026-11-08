import { createTrustedJudgeResolver, workflowJudgePolicy, workflowJudgeRuntime, type TrustedJudgeRuntime } from './rich-judge';
import { deliverRemediationCost } from './rich-remediation';
import 'server-only';
import { createHash } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import type { ServiceContext } from '@ae/core/contracts/services';
import { IntakeInput } from '@ae/core/contracts/index';
import { createTextEvaluationServices, PostgresTextCheckpointStore } from '@ae/core/evals/integration/index';
import { createCalendarEvaluationServices } from '@ae/core/evals/calendar-integration/index';
import { TrackBBlockedError, TrackBPendingError, toContractCost, createTrackBServices } from '@ae/core/evals/service-adapter';
import { buildAgentDeps } from '@ae/core/integration/eval-services';
import { withAgentCostDelivery } from '@ae/core/agents/runtime';
import { pooledCalendarDatabase } from '@ae/core/simulator/pool';
import { PostgresBranchLedger } from '@ae/core/simulator/branch-ledger';
import { PostgresCalendarStore } from '@ae/core/simulator/postgres';
import { CalendarSimulator } from '@ae/core/simulator/calendar';
import { createTextTarget } from '@ae/core/targets/text';
import { platformTarget } from '@ae/core/targets/adapters';
import type { JobRef } from '@ae/core/evals/types';
import type { CalendarSuiteInput } from '@ae/core/simulator/workflow/index';
import { getJobWithDecryptedCredentials, recordCost } from './job-store';
import { createRichRemediation } from './rich-remediation';
import { createWorkflowInventory } from './workflow-inventory';
import { createApprovedSuiteAdmission } from '@ae/core/evals/integration/approved-suite';
import { advanceWorkflowData, readWorkflowDataPlan, readWorkflowDataReady } from './workflow-data';
import { evalServices } from '@ae/core/integration/eval-services';

let applicationPool: Pool | undefined;
export function workflowSql() {
  if (!process.env.DATABASE_URL) throw new TrackBBlockedError('needs_operator', 'Application database configuration required.');
  applicationPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5, connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000, options: '-c statement_timeout=30000 -c lock_timeout=10000' });
  return pooledCalendarDatabase(applicationPool);
}
const refused = (): never => { throw new TrackBBlockedError('needs_operator', 'Canonical Workflow binding unavailable or changed; operator reconciliation required.'); };

/** Internal Workflow authority only; no route accepts this value from a customer body. */
export async function createRichWorkflowServices(ctx: ServiceContext, authority: { workflowRunId: string; judgeRuntime?: TrustedJudgeRuntime }) {
  const sql = workflowSql();
  async function canonical() {
    const loaded = await getJobWithDecryptedCredentials(ctx.jobId);
    if (!loaded || !authority.workflowRunId || loaded.job.workflowRunId !== authority.workflowRunId
      || loaded.job.environment !== ctx.environment || loaded.job.isMock
      || !['planning', 'running', 'investigating'].includes(loaded.job.state)) return refused();
    const intake = IntakeInput.parse(loaded.intake);
    if (intake.package !== 'text_eval' && intake.package !== 'workflow_eval') return refused();
    const binding = await sql.query<{ target_revision: string; reviewed_calendar: CalendarSuiteInput | null; isolation: string | null; remediation_operation_micro_usd: number | string | null; baseline_suite_digest: string | null; baseline_run_id: string | null }>(
      'SELECT target_revision, reviewed_calendar, isolation, remediation_operation_micro_usd, baseline_suite_digest, baseline_run_id FROM workflow_integration.bindings WHERE job_id=$1', [ctx.jobId]);
    const b = binding.rows[0];
    if (!b || !/^[A-Za-z0-9_.:-]{1,128}$/.test(b.target_revision)) return refused();
    const fixture = await sql.query<{ fixture: boolean }>('SELECT is_internal_fixture AS fixture FROM customers WHERE id=$1', [loaded.job.customerId]);
    const job: JobRef = { jobId: ctx.jobId, customerId: loaded.job.customerId, package: intake.package,
      environment: ctx.environment, isFixture: fixture.rows[0]?.fixture === true, linkedRetestOf: loaded.job.retestOfJobId, quoteVersion: null };
    const knownSecrets = Object.values(loaded.credentials).filter((x): x is string => typeof x === 'string');
    if (knownSecrets.some(s => s.length < 4)) return refused();
    // The ciphertext changes with credential rotation; hash stays server-only and never enters artifacts.
    const credentials = await sql.query<{ ciphertext: string }>('SELECT ciphertext FROM job_credentials WHERE job_id=$1', [ctx.jobId]);
    const targetVersion = createHash('sha256').update(JSON.stringify({ endpoint: { ...intake.endpoint, apiKey: undefined },
      revision: b.target_revision, credentialCiphertext: credentials.rows[0]?.ciphertext ?? null })).digest('hex');
    return { ...loaded, row: loaded.job, intake, job, knownSecrets, targetVersion, binding: { ...b,
      // PostgreSQL bigint is a string in the actual driver; validate before narrowing.
      remediation_operation_micro_usd: b.remediation_operation_micro_usd === null ? null : (() => {
        const amount = Number(b.remediation_operation_micro_usd);
        if (!Number.isSafeInteger(amount) || amount <= 0) return refused();
        return amount;
      })() } };
  }
  const judgeRuntime = authority.judgeRuntime ?? workflowJudgeRuntime();
  const judge = createTrustedJudgeResolver({ sql, checkpoints: new PostgresTextCheckpointStore(sql), canonical,
    policy: workflowJudgePolicy(), runtime: { ...judgeRuntime, beforeDispatch: async intent => {
      if (ctx.budgetMicroUsd <= 0) return refused();
      await judgeRuntime.beforeDispatch(intent);
    } }, deliverCost: deliverRemediationCost });
  const initial = await canonical();
  const inventory = createWorkflowInventory(sql, { tenantId: initial.job.customerId, jobId: ctx.jobId, environment: ctx.environment });
  const checkpoints = inventory.wrap(new PostgresTextCheckpointStore(sql));
  const agentDeps = await buildAgentDeps();
  const runner = withAgentCostDelivery(agentDeps.runner, { record: async (_key, cost) => recordCost({ ...toContractCost(cost), jobId: cost.jobId }) });
  const dataScope = { tenantId: initial.job.customerId, jobId: ctx.jobId, environment: ctx.environment, workflowRunId: authority.workflowRunId };
  const approved = createApprovedSuiteAdmission({ resolve: async (current, suiteDigest) => {
    if (current.jobId !== ctx.jobId || current.environment !== ctx.environment) return refused();
    const a = await canonical();
    if (a.job.package !== 'text_eval') return refused();
    const ready = await readWorkflowDataReady(sql, dataScope, a.knownSecrets);
    if (!ready) {
      if (await readWorkflowDataPlan(sql, dataScope, a.knownSecrets)) throw new TrackBPendingError(5000, 'Approved data is incomplete; suite fallback refused.');
      return null;
    }
    if (ready.result.frozen?.suite.digest !== suiteDigest) return refused();
    return { job: a.job, knownSecrets: a.knownSecrets, context: ready.input.context, result: ready.result };
  } });
  async function advanceData() {
    const a = await canonical();
    if (a.job.package !== 'text_eval') return refused();
    return advanceWorkflowData(sql, dataScope, a.knownSecrets, inventory);
  }
  const text = createTextEvaluationServices({ runner, checkpoints, resolveApprovedSuite: approved.resolveApprovedSuite, resolve: async current => {
    if (current.jobId !== ctx.jobId || current.environment !== ctx.environment) return refused();
    const a = await canonical();
    return { job: a.job, target: createTextTarget(a.intake.endpoint), targetVersion: a.targetVersion,
      judge, knownSecrets: a.knownSecrets };
  } });
  const remediation = createRichRemediation({ sql, runner, checkpoints, canonical, text, judge });
  let branchBinding: { connection: string; pool: Pool } | undefined;
  const calendar = createCalendarEvaluationServices({ checkpoints, journalPool: applicationPool!, resolve: async current => {
    if (current.jobId !== ctx.jobId || current.environment !== ctx.environment) return refused();
    const a = await canonical();
    if (!a.row.neonBranchId || !a.binding.reviewed_calendar) return refused();
    const ledger = new PostgresBranchLedger(applicationPool!);
    const owned = await ledger.findOwnedBranch(a.row.neonBranchId);
    if (!owned || owned.jobId !== ctx.jobId || owned.state !== 'ready') return refused();
    const connection = await evalServices.getJobBranchConnection!(a.row.neonBranchId);
    if (branchBinding && branchBinding.connection !== connection) return refused();
    branchBinding ??= { connection, pool: new Pool({ connectionString: connection, max: 2, connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 1000, options: '-c statement_timeout=30000 -c lock_timeout=10000' }) };
    const db = pooledCalendarDatabase(branchBinding.pool);
    return { job: a.job, targetVersion: a.targetVersion,
      branch: { jobId: ctx.jobId, branchId: a.row.neonBranchId, targetVersion: a.targetVersion },
      reviewedSuite: a.binding.reviewed_calendar, systemPrompt: a.intake.endpoint.systemPrompt, knownSecrets: a.knownSecrets,
      dependencies: { db, simulator: new CalendarSimulator(new PostgresCalendarStore(db)), targetForScenario: () => platformTarget(a.intake.endpoint) } };
  } });
  const reportServices = createTrackBServices({ runner,
    resolveJob: async current => {
      if (current.jobId !== ctx.jobId || current.environment !== ctx.environment) return refused();
      return (await canonical()).job;
    }, resolveKnownSecrets: async () => (await canonical()).knownSecrets,
    // Missing non-session billing remains explicitly unknown in the report.
  });
  async function bindTextBaseline(suiteDigest: string, runId: string) {
    const a = await canonical();
    if (a.job.package !== 'text_eval') return refused();
    await text.reportInput(ctx, { suiteDigest, runId }); // completed investigation and exact associations required
    await sql.query(`UPDATE workflow_integration.bindings SET baseline_suite_digest=$2,baseline_run_id=$3
      WHERE job_id=$1 AND (baseline_suite_digest IS NULL OR (baseline_suite_digest=$2 AND baseline_run_id=$3))
      RETURNING job_id`, [ctx.jobId,suiteDigest,runId]).then(r => { if (r.rows.length !== 1) return refused(); });
  }
  async function resolvePackTarget() {
    const a = await canonical();
    if (a.job.package !== 'text_eval') return refused();
    return { configuration: { endpoint: a.intake.endpoint.url, model: a.intake.endpoint.model,
      configurationVersion: a.targetVersion, systemPrompt: a.intake.endpoint.systemPrompt || null },
      target: createTextTarget(a.intake.endpoint), knownSecrets: a.knownSecrets };
  }
  /** Discovery is read-only. Approved admission creates neither design nor suite checkpoints. */
  async function resolvePackBaseSuite(expectedDigest?: string) {
    const a = await canonical();
    if (a.job.package !== 'text_eval') return refused();
    const plan = await readWorkflowDataPlan(sql, dataScope, a.knownSecrets);
    let digest: string;
    if (plan) {
      const ready = await readWorkflowDataReady(sql, dataScope, a.knownSecrets);
      if (!ready?.result.frozen) throw new TrackBPendingError(5000, 'Approved data is incomplete; finish retained review and admission before pack review.');
      digest = ready.result.frozen.suite.digest;
      if (!await approved.get(ctx, digest)) return refused();
    } else {
      const tasks = await sql.query('SELECT task_id FROM evaluation_data_persistence.tasks WHERE tenant_id=$1 AND job_id=$2', [a.job.customerId, ctx.jobId]);
      if (tasks.rows.length) throw new TrackBBlockedError('needs_operator', 'Data tasks require an immutable approved-data plan; design fallback refused.');
      // Legacy design is used only to discover an identity; supported getSuite
      // performs target binding, secret checks and current service authorization.
      const stored = await checkpoints.get({ jobId: ctx.jobId, kind: 'design', id: `suite:${ctx.jobId}:frozen12` });
      const design = stored?.state === 'completed' ? stored.value as { status: string; suite: { digest: string } } : null;
      if (design?.status !== 'completed') throw new TrackBBlockedError('needs_operator', 'Retain a completed base12 design before pack review.');
      digest = design.suite.digest;
    }
    if (expectedDigest && digest !== expectedDigest) return refused();
    const suite = await text.getSuite(ctx, digest);
    if (suite.jobId !== ctx.jobId || suite.scenarios.length !== 12) return refused();
    return suite;
  }
  return { resolvePackTarget, resolvePackBaseSuite, text, calendar, remediation, inventory, advanceData, approvedData: approved.get, branchId: initial.row.neonBranchId ?? undefined, dispose: async () => { await branchBinding?.pool.end(); }, renderReport: reportServices.renderReport, bindTextBaseline, intake: initial.intake, job: initial.job,
    targetVersion: initial.targetVersion, knownSecrets: initial.knownSecrets };
}

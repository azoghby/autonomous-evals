import { assertAutonomousPaidContext, type AutonomousPaidContext } from './autonomous-paid';
import type { createTrustedJudgeResolver } from './rich-judge';
import 'server-only';
import type { AgentTaskRunner } from '@ae/core/agents/session-service';
import type { AgentTransactionalSql, AgentSqlExecutor } from '@ae/core/agents/postgres-ports';
import { ROLE_DEFINITIONS } from '@ae/core/agents/roles';
import { PRICE_TABLE } from '@ae/core/evals/pricing';
import type { JobRef } from '@ae/core/evals/types';
import type { TextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import type { createTextEvaluationServices } from '@ae/core/evals/integration/services';
import { createRemediationServices, remediationDigest } from '@ae/core/evals/remediation/index';
import { PostgresRemediationAccounting } from '@ae/core/evals/remediation/accounting/index';
import { createRemediationTarget } from '@ae/core/targets/remediation';
import { TrackBBlockedError } from '@ae/core/evals/service-adapter';
import { canonicalJson } from '@ae/core/evals/text/index';

const refused = (): never => { throw new TrackBBlockedError('needs_operator', 'Saved remediation authority or baseline changed; reconciliation required.'); };
export interface RemediationCanonical {
  job: JobRef; knownSecrets: readonly string[]; targetVersion: string;
  intake: { endpoint: { url: string; model: string; apiKey?: string } };
  binding: { isolation: string | null; remediation_operation_micro_usd: number | null; baseline_suite_digest: string | null; baseline_run_id: string | null };
}
/** One global keyed protocol across session, Gateway and HTTP provider facts.
 * Target HTTP has its own typed table: it must never masquerade as a Naive/Gateway charge. */
export async function deliverRemediationCost(tx: AgentSqlExecutor, entry: {
  jobId: string; operationId: string; kind: 'target' | 'judge'; microUsd: number; idempotencyKey: string; receiptId: string;
}) {
  if (!Number.isSafeInteger(entry.microUsd) || entry.microUsd < 0 || !entry.idempotencyKey || !entry.receiptId) refused();
  const payload = { ...entry, source: entry.kind === 'target' ? 'target_http' : 'ai_gateway' };
  const claimed = await tx.query(`INSERT INTO workflow_integration.cost_keys(job_id,key,payload)
    VALUES($1,$2,$3::jsonb) ON CONFLICT(key) DO NOTHING RETURNING key`, [entry.jobId, entry.idempotencyKey, canonicalJson(payload)]);
  if (!claimed.rows.length) {
    const old = await tx.query<{ agrees: boolean }>('SELECT payload=$3::jsonb AS agrees FROM workflow_integration.cost_keys WHERE job_id=$1 AND key=$2', [entry.jobId, entry.idempotencyKey, canonicalJson(payload)]);
    if (old.rows[0]?.agrees !== true) refused();
    return;
  }
  await tx.query(`INSERT INTO workflow_integration.provider_costs(job_id,key,source,operation_id,receipt_id,micro_usd)
    VALUES($1,$2,$3,$4,$5,$6)`, [entry.jobId, entry.idempotencyKey, payload.source, entry.operationId, entry.receiptId, entry.microUsd]);
}

/** Internal Workflow closure; request finding IDs select only canonical retained investigation facts. */
export function createRichRemediation(deps: {
  autonomous?: AutonomousPaidContext;
  sql: AgentTransactionalSql; runner: AgentTaskRunner; checkpoints: TextCheckpointStore;
  canonical(): Promise<RemediationCanonical>;
  text: ReturnType<typeof createTextEvaluationServices>;
  judge?: ReturnType<typeof createTrustedJudgeResolver>;
}) {
  if (deps.autonomous) assertAutonomousPaidContext(deps.autonomous);
  return createRemediationServices({ runner: deps.autonomous?.runner ?? deps.runner, checkpoints: deps.checkpoints, resolve: async (ctx, findingId) => {
    const a = await deps.canonical();
    await deps.autonomous?.guard(a.job,deps.sql);
    if (a.job.jobId !== ctx.jobId || a.job.environment !== ctx.environment || a.job.package !== 'text_eval') return refused();
    const suiteDigest = a.binding.baseline_suite_digest, runId = a.binding.baseline_run_id;
    if (!suiteDigest || !runId) return refused();
    // reportInput reads the stored frozen suite/run/investigation, never request/model prose.
    const saved = await deps.text.reportInput(ctx, { suiteDigest, runId });
    const identity = await deps.checkpoints.get({ jobId: ctx.jobId, kind: 'run_identity', id: runId });
    if (identity?.state !== 'completed' || (identity.value as { targetVersion?: string }).targetVersion !== a.targetVersion) return refused();
    const finding = saved.richFindings.find(f => f.id === findingId);
    if (!finding || finding.label !== 'confirmed') return refused();
    const failingCheckIds = [...new Set(finding.evidence.flatMap(e => e.kind === 'check' && saved.run.executions.some(s => s.checks.some(c => c.checkId === e.checkId && c.kind === 'objective' && c.status === 'fail')) ? [e.checkId] : []))];
    if (!failingCheckIds.length || saved.suite.scenarios.length !== 12) return refused();
    const binding = { targetId: `job:${ctx.jobId}:endpoint`, targetVersion: a.targetVersion, environment: ctx.environment };
    const original = { suite: saved.suite, run: saved.run, binding, failingCheckIds };
    const trialId = `trial:${remediationDigest({ binding, findingId, suiteDigest, runId })}`;
    const bound = a.binding.remediation_operation_micro_usd;
    const enabled = a.binding.isolation === 'request_messages_only' && Number.isSafeInteger(bound) && Number(bound) > 0;
    const period = deps.autonomous?.policy.periodId ?? process.env.NAIVE_BUDGET_PERIOD_ID;
    if (deps.autonomous && enabled && Number(bound)!==deps.autonomous.targetReservationMicroUsd) return refused();
    if (enabled && (!period || !/^[A-Za-z0-9_-]+$/.test(period))) return refused();
    const accounting = new PostgresRemediationAccounting({ sql: deps.sql, jobId: ctx.jobId,
      reservation: deps.autonomous ? deps.autonomous.reservation('target') : op => ({ reservationId: op.operationId, jobId: ctx.jobId, amountMicroUsd: Number(bound), scopes: [
        { key: `job:${ctx.jobId}`, capMicroUsd: PRICE_TABLE[a.job.package].jobBudgetMicroUsd },
        { key: `agent:evaluation_engineer:${period}`, capMicroUsd: ROLE_DEFINITIONS.evaluation_engineer.periodCapMicroUsd },
      ] }), deliverCost: deliverRemediationCost });
    const trial = enabled ? createRemediationTarget({
      scope: { job: a.job, finding, binding, original, trialId,
        endpoint: { kind: 'stateless_chat_completions', isolation: 'request_messages_only', ...a.intake.endpoint } },
      currentSecrets: async () => {
        await deps.autonomous?.guard(a.job,deps.sql);
        const latest = await deps.canonical();
        if (latest.targetVersion !== a.targetVersion || latest.binding.isolation !== a.binding.isolation
          || latest.binding.remediation_operation_micro_usd !== bound) return refused();
        return latest.knownSecrets;
      }, accounting: { beforeDispatch: accounting.beforeDispatch.bind(accounting), observed: accounting.observed.bind(accounting), ambiguous: accounting.ambiguous.bind(accounting) }, limits: { timeoutMs: 15000, maxCompletionTokens: 512, maxRequestBytes: 256000, maxResponseBytes: 1000000 },
    }) : null;
    // The shared secured judge owns its durable reservation, usage and keyed delivery.
    return { job: a.job, finding, knownSecrets: a.knownSecrets, binding, original, trial, judge: deps.judge ? async input => ({ value: await deps.judge!(input), costs: [] }) : null,
      authorize: async op => { await deps.autonomous?.guard(a.job,deps.sql); return op.kind === 'judge' ? Boolean(deps.judge) : enabled ? accounting.authorize(op) : false; } };
  } });
}

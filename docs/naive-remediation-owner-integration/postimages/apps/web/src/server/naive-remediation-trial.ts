import 'server-only';
import type { AgentSqlExecutor, AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { SharedJobBudgetLedger } from '@ae/core/db/job-budget-ledger';
import type { BudgetReservationRequest, RubricJudge } from '@ae/core/evals/types';
import type { AuthorizedRemediation } from '@ae/core/evals/remediation/index';
import { canonicalJson } from '@ae/core/evals/text/index';
import { PostgresRemediationAccounting, type RemediationOperation } from '@ae/core/evals/remediation/accounting/index';
import { createRemediationTarget, type RemediationTargetDeps, type RemediationTargetScope } from '@ae/core/targets/remediation';

const refused = (): never => { throw new Error('NAIVE_REMEDIATION_TRIAL_HOLD'); };
const pinned = (tx: AgentSqlExecutor): AgentTransactionalSql => ({ query: tx.query.bind(tx), transaction: fn => fn(tx) });

export interface NaiveRemediationTrialDeps {
  sql: AgentTransactionalSql;
  /** Canonical owner policy must explicitly attest stateless request-message isolation.
   * An arbitrary endpoint URL or a model-generated assertion does not establish this scope. */
  scope: RemediationTargetScope;
  operationMicroUsd: number;
  /** Exact job and allocation scopes from the shared text runtime, plus optional stricter scopes. */
  reservationScopes: BudgetReservationRequest['scopes'];
  /** Rechecks the complete canonical binding, consent, credentials and enabled trial policy. */
  assertCurrent(): Promise<readonly string[]>;
  /** Locks the canonical job first and validates current authority in this transaction. */
  assertCurrentInTransaction(tx: AgentSqlExecutor): Promise<void>;
  /** Existing Naive proxy judge, including its durable dispatch/accounting protocol. */
  resolveJudge(): Promise<RubricJudge | null>;
  transport?: RemediationTargetDeps['transport'];
  limits?: RemediationTargetDeps['limits'];
}

/** Reuse core durable dispatch/usage fencing, replacing ONLY budget admission with the
 * shared job ledger. No monetary settlement capability is exposed: target HTTP usage has
 * no authoritative monetary receipt here, so every target reservation remains held. */
class SharedRemediationAccounting extends PostgresRemediationAccounting {
  constructor(private readonly owner: NaiveRemediationTrialDeps) {
    super({ sql: owner.sql, jobId: owner.scope.job.jobId,
      reservation: () => refused(), deliverCost: async () => refused() });
  }
  override async authorize(operation: RemediationOperation): Promise<boolean> {
    if (operation.kind !== 'target' || !operation.operationId || operation.operationId.length > 4096
      || !/^[a-f0-9]{64}$/.test(operation.inputDigest)) return refused();
    await this.owner.assertCurrent();
    const reservation: BudgetReservationRequest = { reservationId: operation.operationId,
      jobId: this.owner.scope.job.jobId, amountMicroUsd: this.owner.operationMicroUsd,
      scopes: structuredClone(this.owner.reservationScopes) };
    return this.owner.sql.transaction(async tx => {
      await this.owner.assertCurrentInTransaction(tx);
      await tx.query(`INSERT INTO remediation_accounting.operations(operation_id,job_id,kind,input_digest,reservation)
        VALUES($1,$2,'target',$3,$4::jsonb) ON CONFLICT DO NOTHING`,
      [operation.operationId,reservation.jobId,operation.inputDigest,canonicalJson(reservation)]);
      const row=(await tx.query<{job_id:string;kind:string;input_digest:string;allowed:boolean|null;agrees:boolean}>(
        `SELECT *,reservation=$2::jsonb AS agrees FROM remediation_accounting.operations WHERE operation_id=$1 FOR UPDATE`,
        [operation.operationId,canonicalJson(reservation)])).rows[0];
      if (!row || row.job_id !== reservation.jobId || row.kind !== 'target'
        || row.input_digest !== operation.inputDigest || row.agrees !== true) return refused();
      if (row.allowed !== null) return row.allowed;
      const admitted=await new SharedJobBudgetLedger(pinned(tx)).reserve(reservation);
      await tx.query('UPDATE remediation_accounting.operations SET allowed=$2 WHERE operation_id=$1',[operation.operationId,admitted.ok]);
      if (admitted.ok) await tx.query(`INSERT INTO remediation_accounting.reconciliation_outbox(operation_id,pending,reason)
        VALUES($1,true,'reserved') ON CONFLICT DO NOTHING`,[operation.operationId]);
      return admitted.ok;
    });
  }
}

/** Stateless replacement-prompt trial. The core observer derives AppliedReceipt from
 * the immutable serialized messages actually handed to secured HTTPS transport. */
export function createNaiveRemediationTrial(raw: NaiveRemediationTrialDeps): Pick<AuthorizedRemediation,'trial'|'judge'|'authorize'> {
  const deps={...raw,scope:structuredClone(raw.scope),reservationScopes:structuredClone(raw.reservationScopes)};
  if (deps.scope.endpoint.kind !== 'stateless_chat_completions' || deps.scope.endpoint.isolation !== 'request_messages_only'
    || !Number.isSafeInteger(deps.operationMicroUsd) || deps.operationMicroUsd <= 0
    || !deps.reservationScopes.some(s => s.key === `job:${deps.scope.job.jobId}` && Number.isSafeInteger(s.capMicroUsd) && s.capMicroUsd >= deps.operationMicroUsd)
    || !deps.reservationScopes.some(s => /^agent:[a-z_]+:[A-Za-z0-9_-]+$/.test(s.key))
    || !deps.reservationScopes.some(s => s.key.startsWith('generic-text:') && s.key.endsWith(`:${deps.scope.job.jobId}`))) return refused();
  const accounting=new SharedRemediationAccounting(deps);
  const trial=createRemediationTarget({scope:deps.scope,currentSecrets:deps.assertCurrent,
    accounting:{beforeDispatch:async evidence=>deps.sql.transaction(async tx=>{
      await deps.assertCurrentInTransaction(tx);
      // Join the owner transaction: job lock precedes durable operation fencing.
      const joined=new PostgresRemediationAccounting({sql:pinned(tx),jobId:deps.scope.job.jobId,
        reservation:()=>refused(),deliverCost:async()=>refused()});
      await joined.beforeDispatch(evidence);
    }),observed:accounting.observed.bind(accounting),ambiguous:accounting.ambiguous.bind(accounting)},
    limits:deps.limits??{timeoutMs:15000,maxCompletionTokens:512,maxRequestBytes:256000,maxResponseBytes:1000000},
    ...(deps.transport?{transport:deps.transport}:{})});
  return {trial,
    authorize:async operation=>{
      await deps.assertCurrent();
      if(operation.kind==='target')return accounting.authorize(operation);
      // The existing proxy judge reserves its own stable operation on the SAME ledger.
      // A second outer reservation would double-count or invent a proxy charge.
      return (await deps.resolveJudge())!==null;
    },
    judge:async input=>{
      await deps.assertCurrent();
      const judge=await deps.resolveJudge();if(!judge)return refused();
      const value=await judge(input);
      await deps.assertCurrent();
      return {value,costs:[]};
    }};
}

import 'server-only';
import { createAutonomousPaidReservationPolicy } from '@ae/core/agents/autonomy/budget';
import { createAutonomousPolicy, autonomyDigest, type AutonomousPolicy } from '@ae/core/agents/autonomy/policy';
import { PostgresBudgetLedger, type AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import type { AgentTaskRunner } from '@ae/core/agents/session-service';
import type { BudgetReservationRequest, JobRef } from '@ae/core/evals/types';
import type { RemediationAccountingDeps } from '@ae/core/evals/remediation/accounting/index';

export type PaidMonitor = { key: string; capMicroUsd: number };
export interface PaidReceipt { operationId: string; inputDigest: string; receiptId: string; microUsd: number | null; evidence: unknown }
const refuse = (): never => { throw new Error('autonomous_paid_authority_or_reconciliation_required'); };
const issued = new WeakSet<object>();
export interface AutonomousPaidContext {
  readonly job: JobRef; readonly policy: AutonomousPolicy; readonly sql: AgentTransactionalSql;
  readonly runner: AgentTaskRunner;
  runnerForMonitor(monitor: PaidMonitor): AgentTaskRunner; readonly targetReservationMicroUsd: number; readonly judgeReservationMicroUsd: number;
  guard(job?: JobRef, sql?: AgentTransactionalSql): Promise<void>;
  reservation(kind: 'target' | 'judge', monitor?: PaidMonitor): (op: {operationId: string}) => BudgetReservationRequest;
  reconcile(receipt: PaidReceipt): Promise<void>;
}
export function assertAutonomousPaidContext(value: AutonomousPaidContext): void {
  if (!value || !issued.has(value)) refuse();
}
/** Created only by authenticated company composition. A parsed HTTP object cannot carry this capability.
 * guard must compare the current company/job/owner and complete immutable policy to these pins.
 * The SQL port must be the exact port constructing the guarded autonomous Naive runner. */
export function createAutonomousPaidContext(input: {
  sql: AgentTransactionalSql; policy: AutonomousPolicy; job: JobRef; runner: AgentTaskRunner;
  runnerForMonitor?(monitor: PaidMonitor): AgentTaskRunner;
  guard(): Promise<void>; jobCapMicroUsd: number; targetReservationMicroUsd: number; judgeReservationMicroUsd: number;
  deliverCost: RemediationAccountingDeps['deliverCost'];
  verifyReceipt?(receipt: Readonly<PaidReceipt>): Promise<boolean>;
}): AutonomousPaidContext {
  const policy = createAutonomousPolicy(input.policy), job = Object.freeze(structuredClone(input.job));
  const factories = {
    target: createAutonomousPaidReservationPolicy({policy,job,role:'evaluation_engineer',jobCapMicroUsd:input.jobCapMicroUsd,reservationMicroUsd:input.targetReservationMicroUsd}),
    judge: createAutonomousPaidReservationPolicy({policy,job,role:'evaluation_engineer',jobCapMicroUsd:input.jobCapMicroUsd,reservationMicroUsd:input.judgeReservationMicroUsd}),
  };
  // Snapshot callbacks and transport references: mutating a constructor argument cannot replace authority.
  const {sql, runner, guard, deliverCost, verifyReceipt,runnerForMonitor} = input;
  const jobCap=input.jobCapMicroUsd;
  const guarded=(raw:AgentTaskRunner):AgentTaskRunner=>({async run(spec){
    await guard();
    if(autonomyDigest(spec.job)!==autonomyDigest(job)
      || spec.jobCapMicroUsd!==undefined && spec.jobCapMicroUsd!==jobCap) refuse();
    const result=await raw.run({...spec,jobCapMicroUsd:jobCap});
    await guard();
    return result;
  }});
  const context: AutonomousPaidContext = Object.freeze({sql,job,policy,runner:guarded(runner),
    runnerForMonitor(monitor:PaidMonitor) {
      context.reservation('target',monitor); // validate before constructing any transport
      if(!runnerForMonitor) return refuse();
      return guarded(runnerForMonitor({...monitor}));
    },
    targetReservationMicroUsd:input.targetReservationMicroUsd,judgeReservationMicroUsd:input.judgeReservationMicroUsd,
    async guard(expected?: JobRef, db?: AgentTransactionalSql) {
      if (expected && autonomyDigest(expected)!==autonomyDigest(job) || db && db!==sql) refuse();
      await guard();
    },
    reservation(kind: 'target'|'judge', monitor?: PaidMonitor) {
      if (!factories[kind]) return refuse();
      if (monitor && (!/^monitor:[A-Za-z0-9_.:-]+:[A-Za-z0-9_.:-]+$/.test(monitor.key) || !Number.isSafeInteger(monitor.capMicroUsd) || monitor.capMicroUsd<=0)) return refuse();
      const pinned = monitor && {...monitor};
      return (op: {operationId:string}) => {
        const reservation = factories[kind](op);
        if (pinned) reservation.scopes.push({key:pinned.key,capMicroUsd:pinned.capMicroUsd});
        return reservation;
      };
    },
    async reconcile(raw: PaidReceipt) {
      const receipt = structuredClone(raw);
      if (typeof receipt.receiptId!=='string' || !receipt.receiptId.length || receipt.receiptId.length>4096 || /[\u0000\uD800-\uDFFF]/u.test(receipt.receiptId) || !/^[a-f0-9]{64}$/.test(receipt.inputDigest) || receipt.microUsd!==null && (!Number.isSafeInteger(receipt.microUsd)||receipt.microUsd<0)) refuse();
      await context.guard();
      if (!verifyReceipt || !await verifyReceipt(Object.freeze(receipt))) refuse();
      await context.guard();
      await sql.transaction(async tx => {
        const row = (await tx.query<{job_id:string;input_digest:string;state:string;receipt:PaidReceipt|null;policy_digest:string;reservation:BudgetReservationRequest}>('SELECT * FROM autonomous_paid_app.operations WHERE operation_id=$1 FOR UPDATE',[receipt.operationId])).rows[0];
        if (!row || row.job_id!==job.jobId || row.input_digest!==receipt.inputDigest || row.policy_digest!==autonomyDigest(policy) || !['dispatched','settled'].includes(row.state)) refuse();
        const originalBase={...row.reservation,scopes:row.reservation.scopes.filter(s=>!s.key.startsWith('monitor:'))};
        if(autonomyDigest(originalBase)!==autonomyDigest(factories.target({operationId:receipt.operationId}))) refuse();
        if (row.receipt && (row.receipt.receiptId!==receipt.receiptId || autonomyDigest(row.receipt.evidence)!==autonomyDigest(receipt.evidence))) refuse();
        if (row.state==='settled') {if (autonomyDigest(row.receipt)!==autonomyDigest(receipt)) refuse();return;}
        if (receipt.microUsd!==null) {
          const pinned:AgentTransactionalSql={query:tx.query.bind(tx),transaction:fn=>fn(tx)};
          const result=await new PostgresBudgetLedger(pinned).settle(receipt.operationId,receipt.microUsd);
          if(result.settledMicroUsd!==receipt.microUsd) refuse();
          await deliverCost(tx,{jobId:job.jobId,operationId:receipt.operationId,kind:'target',microUsd:receipt.microUsd,idempotencyKey:`autonomous-target:${receipt.operationId}`,receiptId:receipt.receiptId});
        }
        await tx.query('UPDATE autonomous_paid_app.operations SET state=$2,receipt=$3::jsonb WHERE operation_id=$1',[receipt.operationId,receipt.microUsd===null?'dispatched':'settled',JSON.stringify(receipt)]);
      });
    },
  });
  issued.add(context);return context;
}

/** Permanent local dispatch intent, never a provider receipt. Stable lifecycle ID excludes payload digest:
 * changing input conflicts under the same identity rather than minting a fresh retry. Unknown cost holds.
 * Caller checkpoints retain results. Any lost acknowledgement requires owner reconciliation, never replay. */
export async function runAutonomousTarget<T>(context: AutonomousPaidContext, operation: {
  operationId: string; input: unknown; job: JobRef; monitor?: PaidMonitor;
}, dispatch: () => Promise<T>): Promise<T> {
  assertAutonomousPaidContext(context);
  await context.guard(operation.job,context.sql);
  const reservation=context.reservation('target',operation.monitor)(operation);
  const digest=autonomyDigest({job:operation.job,input:operation.input,policy:context.policy});
  await context.sql.transaction(async tx=>{
    const inserted=await tx.query(`INSERT INTO autonomous_paid_app.operations(operation_id,job_id,input_digest,reservation,state,policy_digest)
      VALUES($1,$2,$3,$4::jsonb,'reserved',$5) ON CONFLICT DO NOTHING RETURNING operation_id`,[operation.operationId,operation.job.jobId,digest,JSON.stringify(reservation),autonomyDigest(context.policy)]);
    // Even denied/reserved intents are immutable; no lease or fresh-ID retry path.
    if(!inserted.rows.length) refuse();
    const pinned:AgentTransactionalSql={query:tx.query.bind(tx),transaction:fn=>fn(tx)};
    const result=await new PostgresBudgetLedger(pinned).reserve(reservation);
    await tx.query('UPDATE autonomous_paid_app.operations SET state=$2 WHERE operation_id=$1',[operation.operationId,result.ok?'dispatched':'denied']);
  });
  const row=(await context.sql.query<{state:string}>('SELECT state FROM autonomous_paid_app.operations WHERE operation_id=$1',[operation.operationId])).rows[0];
  if(row?.state!=='dispatched') refuse();
  await context.guard(operation.job,context.sql);
  const result=await dispatch();
  await context.guard(operation.job,context.sql);
  return result;
}

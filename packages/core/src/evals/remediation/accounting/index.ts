import { PostgresBudgetLedger, type AgentSqlExecutor, type AgentTransactionalSql } from '../../../agents/postgres-ports';
import type { BudgetReservationRequest } from '../../types';
import type { DispatchEvidence, ObservedUsage } from '../../../targets/remediation';

export interface RemediationOperation { operationId: string; kind: 'target' | 'judge'; inputDigest: string }
export interface RemediationPricedCost {
  jobId: string; operationId: string; kind: 'target' | 'judge'; microUsd: number; idempotencyKey: string; receiptId: string;
}
export interface RemediationAccountingDeps {
  sql: AgentTransactionalSql;
  jobId: string;
  /** Authenticated server policy; include the SAME global/job scopes used by other workflow operations. */
  reservation(operation: Readonly<RemediationOperation>): BudgetReservationRequest;
  /** Reuse upsertWorkflowCost with this pinned tx. Never open a separate transaction or use an unkeyed sink. */
  deliverCost(tx: AgentSqlExecutor, entry: Readonly<RemediationPricedCost>): Promise<void>;
}
interface Row {
  operation_id: string; job_id: string; kind: 'target' | 'judge'; input_digest: string;
  reservation: BudgetReservationRequest; allowed: boolean | null; dispatch_evidence: DispatchEvidence | null;
  usage: ObservedUsage; ambiguous: boolean; settlement: { receiptId: string; microUsd: number } | null;
}
const fail = (): never => { throw new Error('remediation_accounting_conflict'); };
function identity(s: unknown): asserts s is string {
  if (typeof s !== 'string' || !s.length || s.length > 4096 || /[\u0000\uD800-\uDFFF]/u.test(s)) fail();
}
function amount(n: unknown): asserts n is number { if (!Number.isSafeInteger(n) || Number(n) < 0) fail(); }
function digest(s: unknown): asserts s is string { if (typeof s !== 'string' || !/^[a-f0-9]{64}$/.test(s)) fail(); }
function usage(value: ObservedUsage): ObservedUsage {
  if (value === null) return null;
  amount(value.promptTokens); amount(value.completionTokens); amount(value.totalTokens);
  if (value.totalTokens !== value.promptTokens + value.completionTokens || Object.keys(value).sort().join() !== 'completionTokens,promptTokens,totalTokens') fail();
  return { promptTokens:value.promptTokens, completionTokens:value.completionTokens, totalTokens:value.totalTokens };
}
// Adapter never nests a transaction: core reservation/settlement joins our atomic operation transaction.
const pinned = (tx: AgentSqlExecutor): AgentTransactionalSql => ({ ...tx, query: tx.query.bind(tx), transaction: fn => fn(tx) });

/** Durable at-most-one dispatch fence. No leases, automatic retries, fake remote attestation or runtime DDL.
 * A receipt records local dispatched configuration; it is not proof of a remote target's internal behavior.
 */
export class PostgresRemediationAccounting {
  constructor(private readonly deps: RemediationAccountingDeps) { identity(deps.jobId); }
  private async locked(tx: AgentSqlExecutor, operationId: string, inputDigest: string): Promise<Row> {
    identity(operationId); digest(inputDigest);
    const row = (await tx.query<Row>('SELECT * FROM remediation_accounting.operations WHERE operation_id=$1 FOR UPDATE', [operationId])).rows[0];
    if (!row || row.job_id !== this.deps.jobId || row.input_digest !== inputDigest || row.allowed !== true) fail();
    return row;
  }
  private async outbox(tx: AgentSqlExecutor, id: string, reason: string, pending = true, receiptId: string | null = null) {
    await tx.query(`INSERT INTO remediation_accounting.reconciliation_outbox(operation_id,pending,reason,receipt_id)
      VALUES($1,$2,$3,$4) ON CONFLICT(operation_id) DO UPDATE SET pending=EXCLUDED.pending,reason=EXCLUDED.reason,
      receipt_id=COALESCE(EXCLUDED.receipt_id,remediation_accounting.reconciliation_outbox.receipt_id)`, [id,pending,reason,receiptId]);
  }
  async authorize(raw: RemediationOperation): Promise<boolean> {
    const operation = { ...raw }; identity(operation.operationId); digest(operation.inputDigest);
    if (!['target','judge'].includes(operation.kind)) fail();
    const reservation = this.deps.reservation(Object.freeze(operation));
    if (reservation.jobId !== this.deps.jobId || reservation.reservationId !== operation.operationId) fail();
    // Snapshot server policy before acquiring the transaction. BudgetLedger validates all integer/scopes invariants.
    const encoded = JSON.stringify(reservation);
    return this.deps.sql.transaction(async tx => {
      await tx.query(`INSERT INTO remediation_accounting.operations(operation_id,job_id,kind,input_digest,reservation)
        VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`, [operation.operationId,this.deps.jobId,operation.kind,operation.inputDigest,encoded]);
      const row = (await tx.query<Row & { agrees: boolean }>(`SELECT *,reservation=$2::jsonb AS agrees FROM remediation_accounting.operations
        WHERE operation_id=$1 FOR UPDATE`, [operation.operationId,encoded])).rows[0];
      if (!row || row.job_id !== this.deps.jobId || row.kind !== operation.kind || row.input_digest !== operation.inputDigest || !row.agrees) fail();
      if (row.allowed !== null) return row.allowed;
      const reserved = await new PostgresBudgetLedger(pinned(tx)).reserve(JSON.parse(encoded) as BudgetReservationRequest);
      await tx.query('UPDATE remediation_accounting.operations SET allowed=$2 WHERE operation_id=$1', [operation.operationId,reserved.ok]);
      if (reserved.ok) await this.outbox(tx,operation.operationId,'reserved');
      return reserved.ok;
    });
  }
  private checkEvidence(raw: Readonly<DispatchEvidence>): DispatchEvidence {
    const e = { ...raw };
    const keys = ['jobId','targetId','targetVersion','environment','trialId','baselineRunId','suiteDigest','runId','scenarioId','patchDigest','payloadDigest','operationId','inputDigest'];
    if (Object.keys(e).sort().join() !== keys.sort().join()) fail();
    for (const key of keys) { const v = e[key as keyof DispatchEvidence]; if (key.endsWith('Digest')) digest(v); else identity(v); }
    if (e.jobId !== this.deps.jobId || !['test','live'].includes(e.environment)) fail();
    return e;
  }
  async beforeDispatch(raw: Readonly<DispatchEvidence>): Promise<void> {
    const evidence = this.checkEvidence(raw);
    await this.deps.sql.transaction(async tx => {
      const row = await this.locked(tx,evidence.operationId,evidence.inputDigest);
      if (row.kind !== 'target' || row.dispatch_evidence !== null || row.settlement !== null) fail();
      await tx.query('UPDATE remediation_accounting.operations SET dispatch_evidence=$2::jsonb WHERE operation_id=$1', [evidence.operationId,JSON.stringify(evidence)]);
      await this.outbox(tx,evidence.operationId,'dispatched');
    });
  }
  private async matching(tx: AgentSqlExecutor, e: DispatchEvidence): Promise<Row> {
    const row = await this.locked(tx,e.operationId,e.inputDigest);
    const match = (await tx.query<{ agrees: boolean }>('SELECT dispatch_evidence=$2::jsonb AS agrees FROM remediation_accounting.operations WHERE operation_id=$1', [e.operationId,JSON.stringify(e)])).rows[0];
    if (match?.agrees !== true) fail();
    return row;
  }
  private async retainUsage(tx: AgentSqlExecutor, row: Row, value: ObservedUsage) {
    if (value === null) return;
    if (row.usage !== null && JSON.stringify(usage(row.usage)) !== JSON.stringify(value)) fail();
    await tx.query('UPDATE remediation_accounting.operations SET usage=$2::jsonb WHERE operation_id=$1', [row.operation_id,JSON.stringify(value)]);
  }
  async observed(raw: Readonly<DispatchEvidence>, observed: Readonly<ObservedUsage>): Promise<void> {
    const evidence = this.checkEvidence(raw), value = usage(observed);
    await this.deps.sql.transaction(async tx => {
      const row = await this.matching(tx,evidence);
      await this.retainUsage(tx,row,value);
      // Late observations may enrich unknown usage, but never release a hold or rewrite settled money.
      if (!row.settlement) await this.outbox(tx,evidence.operationId,value || row.usage ? 'usage_observed' : 'usage_unknown');
    });
  }
  async ambiguous(raw: Readonly<DispatchEvidence>): Promise<void> {
    const evidence = this.checkEvidence(raw);
    await this.deps.sql.transaction(async tx => {
      const row = await this.matching(tx,evidence);
      await tx.query('UPDATE remediation_accounting.operations SET ambiguous=true WHERE operation_id=$1', [evidence.operationId]);
      if (!row.settlement) await this.outbox(tx,evidence.operationId,'ambiguous');
    });
  }
  /** ONLY authenticated owner/provider reconciliation may call this. receiptId identifies retained external evidence.
   * null money remains unknown and holds reservation. Numeric zero requires authoritative evidence too.
   * It does not complete the engine checkpoint or replay transport; owner reconciles that evidence separately.
   */
  async reconcile(raw: { operationId: string; inputDigest: string; receiptId: string; usage: ObservedUsage; microUsd: number | null }): Promise<void> {
    const input = { ...raw, usage: usage(raw.usage) };
    identity(input.receiptId); if (input.microUsd !== null) amount(input.microUsd);
    const value = usage(input.usage);
    await this.deps.sql.transaction(async tx => {
      const row = await this.locked(tx,input.operationId,input.inputDigest);
      if (!row.dispatch_evidence) fail();
      await this.retainUsage(tx,row,value);
      if (row.settlement) {
        if (row.settlement.microUsd !== input.microUsd || row.settlement.receiptId !== input.receiptId) fail();
        return;
      }
      if (input.microUsd === null) { await this.outbox(tx,input.operationId,'usage_unknown',true,input.receiptId); return; }
      const settled = await new PostgresBudgetLedger(pinned(tx)).settle(input.operationId,input.microUsd);
      if (settled.settledMicroUsd !== input.microUsd) fail();
      await this.deps.deliverCost(tx,{ jobId:this.deps.jobId, operationId:input.operationId, kind:row.kind,
        microUsd:input.microUsd, idempotencyKey:`remediation:${input.operationId}`, receiptId:input.receiptId });
      await tx.query('UPDATE remediation_accounting.operations SET settlement=$2::jsonb WHERE operation_id=$1', [input.operationId,JSON.stringify({ receiptId:input.receiptId,microUsd:input.microUsd })]);
      await this.outbox(tx,input.operationId,'settled',false,input.receiptId);
    });
  }
  async pending(): Promise<unknown[]> {
    return (await this.deps.sql.query(`SELECT o.*,q.reason,q.receipt_id FROM remediation_accounting.operations o
      JOIN remediation_accounting.reconciliation_outbox q USING(operation_id) WHERE o.job_id=$1 AND q.pending=true ORDER BY operation_id`, [this.deps.jobId])).rows;
  }
}

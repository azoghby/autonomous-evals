import type { AgentSqlExecutor } from '@ae/core/agents/postgres-ports';
import { PostgresRemediationAccounting, type RemediationAccountingDeps, type RemediationOperation } from '@ae/core/evals/remediation/accounting/index';
import type { JudgeUsage } from '@ae/core/judges/gateway';
import type { ObservedUsage } from '@ae/core/targets/remediation';

type Operation = RemediationOperation & { kind: 'judge' };
interface Row {
  job_id: string; kind: string; input_digest: string; allowed: boolean | null;
  dispatch_evidence: unknown | null; usage: ObservedUsage; settlement: unknown | null;
}
const conflict = (): never => { throw new Error('judge_reconciliation_required'); };
function checked(raw: RemediationOperation): Operation {
  if (raw.kind !== 'judge' || !raw.operationId || raw.operationId.length > 4096
    || /[\u0000\uD800-\uDFFF]/u.test(raw.operationId) || !/^[a-f0-9]{64}$/.test(raw.inputDigest)) conflict();
  return { operationId: raw.operationId, inputDigest: raw.inputDigest, kind: 'judge' };
}

/** Joins the existing reservation, settlement and globally keyed cost delivery protocol.
 * The same operations row fences dispatch across processes and restarts. A claim is
 * permanent even if the process dies before HTTP: owner reconciliation is required.
 * No lease expiry, automatic retry, local spend estimate or runtime DDL is used.
 */
export class JudgeAccounting {
  private readonly core: PostgresRemediationAccounting;
  constructor(private readonly deps: RemediationAccountingDeps) {
    this.core = new PostgresRemediationAccounting(deps);
  }
  authorize(raw: RemediationOperation): Promise<boolean> {
    return this.core.authorize(checked(raw));
  }
  private async locked(tx: AgentSqlExecutor, op: Operation): Promise<Row> {
    const row = (await tx.query<Row>(
      'SELECT * FROM remediation_accounting.operations WHERE operation_id=$1 FOR UPDATE', [op.operationId])).rows[0];
    if (!row || row.job_id !== this.deps.jobId || row.kind !== 'judge'
      || row.input_digest !== op.inputDigest || row.allowed !== true) return conflict();
    return row;
  }
  private async outbox(tx: AgentSqlExecutor, id: string, reason: string) {
    await tx.query(`INSERT INTO remediation_accounting.reconciliation_outbox(operation_id,pending,reason)
      VALUES($1,true,$2) ON CONFLICT(operation_id) DO UPDATE SET pending=true,reason=EXCLUDED.reason`, [id, reason]);
  }
  async claim(raw: RemediationOperation): Promise<void> {
    const op = checked(raw);
    await this.deps.sql.transaction(async tx => {
      const row = await this.locked(tx, op);
      if (row.dispatch_evidence !== null || row.settlement !== null) return conflict();
      // Local intent receipt, never remote/provider attestation. The bound input digest
      // includes model/config and payload in the trusted app resolver.
      await tx.query('UPDATE remediation_accounting.operations SET dispatch_evidence=$2::jsonb WHERE operation_id=$1',
        [op.operationId, JSON.stringify({ ...op, jobId: this.deps.jobId })]);
      await this.outbox(tx, op.operationId, 'dispatched');
    });
  }
  async observed(raw: RemediationOperation, usage: JudgeUsage): Promise<void> {
    const op = checked(raw);
    if (usage.operationId !== op.operationId || usage.source !== 'ai_gateway'
      || usage.costMicroUsd !== null || !['unknown', 'received'].includes(usage.result)) return conflict();
    for (const n of [usage.promptTokens, usage.completionTokens]) {
      if (n !== null && (!Number.isSafeInteger(n) || n < 0)) return conflict();
    }
    const measured: ObservedUsage = usage.promptTokens === null || usage.completionTokens === null ? null : {
      promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      totalTokens: usage.promptTokens + usage.completionTokens,
    };
    if (measured && !Number.isSafeInteger(measured.totalTokens)) return conflict();
    await this.deps.sql.transaction(async tx => {
      const row = await this.locked(tx, op);
      if (row.dispatch_evidence === null) return conflict();
      if (measured !== null) {
        if (row.usage !== null && (row.usage.promptTokens !== measured.promptTokens
          || row.usage.completionTokens !== measured.completionTokens || row.usage.totalTokens !== measured.totalTokens)) return conflict();
        await tx.query('UPDATE remediation_accounting.operations SET usage=$2::jsonb WHERE operation_id=$1', [op.operationId, JSON.stringify(measured)]);
      }
      if (!row.settlement) await this.outbox(tx, op.operationId,
        usage.result === 'unknown' ? 'ambiguous' : measured || row.usage ? 'usage_observed' : 'usage_unknown');
      if (usage.result === 'unknown') await tx.query('UPDATE remediation_accounting.operations SET ambiguous=true WHERE operation_id=$1', [op.operationId]);
    });
  }
  async ambiguous(raw: RemediationOperation): Promise<void> {
    const op = checked(raw);
    await this.deps.sql.transaction(async tx => {
      const row = await this.locked(tx, op);
      if (row.dispatch_evidence === null) return conflict();
      await tx.query('UPDATE remediation_accounting.operations SET ambiguous=true WHERE operation_id=$1', [op.operationId]);
      if (!row.settlement) await this.outbox(tx, op.operationId, 'ambiguous');
    });
  }
  /** Authenticated provider receipt only. Null money retains the original hold;
   * numeric money settles the ledger and keyed delivery in the same transaction.
   * A lost acknowledgement is safely replayed through the existing core protocol.
   */
  reconcile(input: Parameters<PostgresRemediationAccounting['reconcile']>[0]): Promise<void> {
    return this.core.reconcile(input);
  }
  pending(): Promise<unknown[]> { return this.core.pending(); }
}

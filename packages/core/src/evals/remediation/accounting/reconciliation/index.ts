import { PostgresRemediationAccounting, type RemediationAccountingDeps, type RemediationOperation } from '../index';
import type { AgentSqlExecutor, AgentTransactionalSql } from '../../../../agents/postgres-ports';
import type { BudgetReservationRequest } from '../../../types';
import type { DispatchEvidence, ObservedUsage } from '../../../../targets/remediation';

export interface ProviderBinding {
  operationId: string; inputDigest: string; provider: string; accountId: string; externalRequestId: string;
}
/** Values must come from authenticated, request-specific provider billing evidence, never token estimates. */
export interface ProviderReceipt extends ProviderBinding {
  externalReceiptId: string; currency: 'USD'; microUsd: number; usage: ObservedUsage;
  /** SHA-256 of retained external evidence; the adapter owns independent retention and authentication. */
  evidenceDigest: string;
}
export interface ProviderReceiptAdapter {
  readonly provider: string; readonly accountId: string;
  readonly capability: 'authoritative-priced-receipts' | 'unavailable';
  /** Read only. Must honor abort; no target dispatch, target retries or budget mutation. */
  retrieve(binding: Readonly<ProviderBinding>, options: {signal: AbortSignal}): Promise<ProviderReceipt | null>;
  /** Verify independently retrieved billing authority, including request identity and immutable USD amount.
   * Checking a local signature/type, local operation ID, token count or caller supplied JSON is insufficient. */
  authenticate(receipt: Readonly<ProviderReceipt>, binding: Readonly<ProviderBinding>): Promise<boolean>;
}
export interface PendingOperation extends RemediationOperation {
  jobId: string; reservation: BudgetReservationRequest;
  dispatchEvidence: DispatchEvidence | {operationId:string;inputDigest:string;kind:'judge';jobId:string};
  usage: ObservedUsage;
}
export interface ReconciliationAuthority {
  readonly jobId: string;
  /** All these scopes must occur on the original reservation; no caller supplied broad scan. */
  readonly scopeKeys: readonly string[];
  /** Authenticated server composition only. Must check and lock current owner/job/company policy,
   * revocation and complete original reservation on this same transaction. A null operation
   * is the initial scan authorization check. Throw on rejection.
   * Its locks must serialize with the application's revocation writer through commit. */
  guard(tx: AgentSqlExecutor, operation: Readonly<PendingOperation> | null): Promise<void>;
}
interface OperationRow {
  operation_id: string; job_id: string; kind: 'target'|'judge'; input_digest: string;
  reservation: BudgetReservationRequest; dispatch_evidence: PendingOperation['dispatchEvidence'] | null;
  allowed: boolean | null; usage: ObservedUsage; settlement: {receiptId:string;microUsd:number}|null;
}
export interface ReconciliationWorkerDeps {
  sql: AgentTransactionalSql; authority: ReconciliationAuthority;
  adapters: readonly ProviderReceiptAdapter[];
  reservation: RemediationAccountingDeps['reservation']; deliverCost: RemediationAccountingDeps['deliverCost'];
}
const conflict = (): never => {throw new Error('accounting_reconciliation_conflict');};
function identity(v: unknown): asserts v is string {
  if(typeof v!=='string'||v.length===0||v.length>4096||/[\u0000\uD800-\uDFFF]/u.test(v)) conflict();
}
function digest(v: unknown): asserts v is string {if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v)) conflict();}
function canonical(v: unknown): string {
  if(Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if(v!==null&&typeof v==='object') return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function usage(v: ObservedUsage): void {
  if(v===null)return;
  if(!v||Object.keys(v).sort().join()!=='completionTokens,promptTokens,totalTokens'||
    !Object.values(v).every(n=>Number.isSafeInteger(n)&&n>=0)||v.totalTokens!==v.promptTokens+v.completionTokens) conflict();
}
function binding(raw: ProviderBinding): ProviderBinding {
  const b=structuredClone(raw);
  if(Object.keys(b).sort().join()!=='accountId,externalRequestId,inputDigest,operationId,provider')conflict();
  for(const k of ['operationId','provider','accountId','externalRequestId'] as const)identity(b[k]); digest(b.inputDigest);
  return b;
}
function receipt(raw: ProviderReceipt,b: ProviderBinding, observed: ObservedUsage): ProviderReceipt {
  const r=structuredClone(raw);
  if(Object.keys(r).sort().join()!=='accountId,currency,evidenceDigest,externalReceiptId,externalRequestId,inputDigest,microUsd,operationId,provider,usage') conflict();
  for(const k of Object.keys(b) as (keyof ProviderBinding)[])if(r[k]!==b[k])conflict();
  identity(r.externalReceiptId);digest(r.evidenceDigest);usage(r.usage);
  if(r.currency!=='USD'||!Number.isSafeInteger(r.microUsd)||r.microUsd<0)conflict();
  if(observed!==null&&(r.usage===null||canonical(r.usage)!==canonical(observed)))conflict();
  return r;
}
const pinned=(tx:AgentSqlExecutor):AgentTransactionalSql=>({query:tx.query.bind(tx),transaction:fn=>fn(tx)});
export function reconciliationReceiptId(r: Pick<ProviderReceipt,'provider'|'accountId'|'externalReceiptId'>): string {
  // Canonical tuple, never ambiguous delimiter concatenation or a local operation ID.
  const id=JSON.stringify([r.provider,r.accountId,r.externalReceiptId]);identity(id);return id;
}

/** Bounded read-only receipt lookup and durable settlement. No transport, hold release or engine resume API. */
export class PostgresAccountingReconciliationWorker {
  private readonly sql: AgentTransactionalSql;
  private readonly authority: ReconciliationAuthority;
  private readonly adapters: readonly ProviderReceiptAdapter[];
  private readonly reservation: RemediationAccountingDeps['reservation'];
  private readonly deliverCost: RemediationAccountingDeps['deliverCost'];
  constructor(deps: ReconciliationWorkerDeps) {
    this.sql=deps.sql;this.reservation=deps.reservation;this.deliverCost=deps.deliverCost;
    identity(deps.authority.jobId);
    const scopes=[...deps.authority.scopeKeys];
    if(scopes.length<1||scopes.length>64||new Set(scopes).size!==scopes.length)conflict();
    scopes.forEach(identity);
    this.authority=Object.freeze({jobId:deps.authority.jobId,scopeKeys:Object.freeze(scopes),guard:deps.authority.guard});
    this.adapters=deps.adapters.map(a=>Object.freeze({provider:a.provider,accountId:a.accountId,capability:a.capability,retrieve:a.retrieve.bind(a),authenticate:a.authenticate.bind(a)}));
    const keys=this.adapters.map(a=>{identity(a.provider);identity(a.accountId);if(!['authoritative-priced-receipts','unavailable'].includes(a.capability))conflict();return JSON.stringify([a.provider,a.accountId]);});
    if(new Set(keys).size!==keys.length)conflict();
  }
  private async authorized(tx:AgentSqlExecutor,operationId:string):Promise<PendingOperation> {
    const row=(await tx.query<OperationRow>('SELECT * FROM remediation_accounting.operations WHERE operation_id=$1 FOR UPDATE',[operationId])).rows[0];
    if(!row||row.job_id!==this.authority.jobId||row.allowed!==true||!row.dispatch_evidence)conflict();
    if(!this.authority.scopeKeys.every(key=>row.reservation.scopes.some(s=>s.key===key)))conflict();
    const expected=this.reservation({operationId:row.operation_id,inputDigest:row.input_digest,kind:row.kind});
    if(canonical(expected)!==canonical(row.reservation))conflict();
    const op:PendingOperation={operationId:row.operation_id,inputDigest:row.input_digest,kind:row.kind,jobId:row.job_id,reservation:row.reservation,dispatchEvidence:row.dispatch_evidence!,usage:row.usage};
    await this.authority.guard(tx,Object.freeze(structuredClone(op)));
    return op;
  }
  /** Register only a provider-returned request ID retained by trusted dispatch composition.
   * The provider adapter must independently verify the binding; registration itself is no provider proof. */
  async registerProviderBinding(raw:ProviderBinding):Promise<void> {
    const b=binding(raw);
    await this.sql.transaction(async tx=>{
      const op=await this.authorized(tx,b.operationId);if(op.inputDigest!==b.inputDigest)conflict();
      await tx.query(`INSERT INTO accounting_reconciliation.bindings(operation_id,binding) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING`,[b.operationId,JSON.stringify(b)]);
      const saved=(await tx.query<{binding:ProviderBinding}>('SELECT binding FROM accounting_reconciliation.bindings WHERE operation_id=$1',[b.operationId])).rows[0];
      if(!saved||canonical(saved.binding)!==canonical(b))conflict();
    });
  }
  private async reconcile(operationId:string,timeoutMs:number):Promise<boolean> {
    const candidate=await this.sql.transaction(async tx=>{
      const op=await this.authorized(tx,operationId);
      const saved=(await tx.query<{binding:ProviderBinding;receipt:ProviderReceipt|null}>(`SELECT b.binding,r.receipt FROM accounting_reconciliation.bindings b
        LEFT JOIN accounting_reconciliation.receipts r USING(operation_id) WHERE b.operation_id=$1`,[operationId])).rows[0];
      return {op,saved};
    });
    if(!candidate.saved)return false;
    const b=binding(candidate.saved.binding);
    let retained=candidate.saved.receipt;
    if(!retained) {
      const adapter=this.adapters.find(a=>a.provider===b.provider&&a.accountId===b.accountId);
      if(!adapter||adapter.capability!=='authoritative-priced-receipts')return false;
      const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        const authenticated=await Promise.race([
          (async()=>{
            const raw=await adapter.retrieve(Object.freeze(structuredClone(b)),{signal:abort.signal});
            if(raw===null)return null;
            const r=receipt(raw,b,candidate.op.usage);
            if(!await adapter.authenticate(Object.freeze(structuredClone(r)),Object.freeze(structuredClone(b))))conflict();
            return r;
          })(),
          new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new Error('accounting_reconciliation_lookup_timeout'));},timeoutMs);}),
        ]);
        if(!authenticated)return false;
        retained=authenticated;
      } finally {if(timer)clearTimeout(timer);}
      const r=retained;
      // Retain verified exact evidence BEFORE settlement. A lost settlement acknowledgement/restart
      // reuses these immutable values even when the provider endpoint later returns different data.
      await this.sql.transaction(async tx=>{
        const op=await this.authorized(tx,operationId);receipt(r,b,op.usage);
        await tx.query(`INSERT INTO accounting_reconciliation.receipts(operation_id,provider,account_id,external_receipt_id,receipt)
          VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,[operationId,r.provider,r.accountId,r.externalReceiptId,JSON.stringify(r)]);
        const saved=(await tx.query<{receipt:ProviderReceipt}>('SELECT receipt FROM accounting_reconciliation.receipts WHERE operation_id=$1 FOR UPDATE',[operationId])).rows[0];
        if(!saved||canonical(saved.receipt)!==canonical(r))conflict();
      });
    }
    await this.sql.transaction(async tx=>{
      const op=await this.authorized(tx,operationId);
      const saved=(await tx.query<{receipt:ProviderReceipt}>('SELECT receipt FROM accounting_reconciliation.receipts WHERE operation_id=$1 FOR UPDATE',[operationId])).rows[0];
      if(!saved)conflict();const r=receipt(saved.receipt,b,op.usage);
      await new PostgresRemediationAccounting({sql:pinned(tx),jobId:this.authority.jobId,reservation:this.reservation,deliverCost:this.deliverCost})
        .reconcile({operationId,inputDigest:r.inputDigest,receiptId:reconciliationReceiptId(r),usage:r.usage,microUsd:r.microUsd});
    });
    return true;
  }
  async run(options:{limit:number;afterOperationId?:string;lookupTimeoutMs?:number;maxDurationMs?:number}) {
    const {limit,afterOperationId='',lookupTimeoutMs=5000,maxDurationMs=30000}=options;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(lookupTimeoutMs)||lookupTimeoutMs<1||lookupTimeoutMs>30000||!Number.isSafeInteger(maxDurationMs)||maxDurationMs<1||maxDurationMs>60000)conflict();
    if(afterOperationId)identity(afterOperationId);
    const started=Date.now();
    const rows=await this.sql.transaction(async tx=>{
      await this.authority.guard(tx,null);
      return (await tx.query<{operation_id:string}>(`SELECT o.operation_id FROM remediation_accounting.operations o
      JOIN remediation_accounting.reconciliation_outbox q USING(operation_id)
      WHERE o.job_id=$1 AND o.allowed=true AND o.dispatch_evidence IS NOT NULL AND q.pending=true AND o.operation_id>$2
      AND NOT EXISTS (SELECT 1 FROM unnest($3::text[]) s(key) WHERE NOT EXISTS
        (SELECT 1 FROM jsonb_array_elements(o.reservation->'scopes') v WHERE v->>'key'=s.key))
      ORDER BY o.operation_id LIMIT $4`,[this.authority.jobId,afterOperationId,[...this.authority.scopeKeys],limit])).rows;
    });
    let scanned=0,settled=0,pending=0,failed=0,nextOperationId:string|null=null;
    for(const row of rows) {
      const remaining=maxDurationMs-(Date.now()-started);if(remaining<=0)break;
      scanned++;nextOperationId=row.operation_id;
      try {if(await this.reconcile(row.operation_id,Math.min(lookupTimeoutMs,remaining)))settled++;else pending++;}
      catch {failed++;}
    }
    return {scanned,settled,pending,failed,nextOperationId};
  }
}

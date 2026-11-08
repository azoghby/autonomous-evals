import { createHash } from 'node:crypto';
import { PostgresBudgetLedger, type AgentSqlExecutor, type AgentTransactionalSql } from '../agents/postgres-ports';
import type { BudgetLedger, BudgetReservationRequest, BudgetReservationResult } from '../evals/types';
import { admitModelReservationInTransaction, lockJobBudget, markJobBudgetDispatched } from './job-budget-authority';

const fail = (): never => { throw Error('shared_model_budget_conflict'); };
const bound = (tx:AgentSqlExecutor):AgentTransactionalSql => ({query:(sql,args)=>tx.query(sql,args),transaction:fn=>fn(tx)});
/** Existing role/period/job model-ledger caps remain enforced. The shared job gate
 * adds public costs and outstanding Workflow/Gateway/model commitments atomically.
 * Use only a pinned connection with READ COMMITTED, rollback, and no auto retries. */
export class SharedJobBudgetLedger implements BudgetLedger {
  constructor(private readonly db:AgentTransactionalSql) {}
  async reserve(input:BudgetReservationRequest):Promise<BudgetReservationResult> {
    if (!input || !Number.isSafeInteger(input.amountMicroUsd)||input.amountMicroUsd<1
      ||!Array.isArray(input.scopes)||!input.scopes.length
      ||input.scopes.some(s=>typeof s.key!=='string'||!Number.isSafeInteger(s.capMicroUsd)||s.capMicroUsd<0)) return fail();
    // Expert honorarium promises are a separate obligation/cap, not model spend.
    // Their normal ledger validates the exact expert-only scope shape.
    if(input.scopes.some(s=>s.key.startsWith('expert-'))) return new PostgresBudgetLedger(this.db).reserve(input);
    const request={...input,scopes:[...input.scopes].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)};
    const requestDigest=createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return this.db.transaction(async tx=>{
      const cap=await lockJobBudget(tx,input.jobId);
      const result=await admitModelReservationInTransaction(tx,{
        jobId:input.jobId,reservationId:input.reservationId,amountMicroUsd:input.amountMicroUsd,requestDigest,
      },()=>new PostgresBudgetLedger(bound(tx)).reserve(request));
      if(!result.ok && 'remainingMicroUsd' in result) return {
        ok:false,reservationId:input.reservationId,exhaustedScope:`job:${input.jobId}`,
        capMicroUsd:cap,availableMicroUsd:result.remainingMicroUsd,
      };
      if(result.ok) await markJobBudgetDispatched(tx,input.jobId,`model:${input.reservationId}`);
      return result;
    });
  }
  async settle(reservationId:string,consumedMicroUsd:number) {
    return this.db.transaction(async tx=>{
      const r=(await tx.query<{job_id:string;scopes:{key:string}[]}>(
        'SELECT job_id,scopes FROM agent_persistence.reservations WHERE id=$1',[reservationId])).rows[0];
      if(!r)return fail();
      if(!r.scopes.some(s=>s.key.startsWith('expert-')))await lockJobBudget(tx,r.job_id);
      const settled=await new PostgresBudgetLedger(bound(tx)).settle(reservationId,consumedMicroUsd);
      if(settled.settledMicroUsd!==consumedMicroUsd)return fail();
      // Until an exact provider receipt is linked, this measured commitment stays
      // counted even when the application cost delivery has not yet happened.
      return settled;
    });
  }
}

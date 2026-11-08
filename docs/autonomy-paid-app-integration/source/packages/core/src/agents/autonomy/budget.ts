import type { BudgetLedger, BudgetReservationRequest, JobRef } from '../../evals/types';
import { JobRefSchema } from '../../evals/types';
import { ROLE_DEFINITIONS } from '../roles';
import { createAutonomousPolicy, type AutonomousPolicy, type AutonomyRole } from './policy';

/** One monetary reservation spans the existing job/role scopes and company root.
 * This is policy construction, not customer authentication or dispatch authority. */
function scoped(request: BudgetReservationRequest, p: AutonomousPolicy): BudgetReservationRequest {
 const copy=structuredClone(request);
 const roles=copy.scopes.filter(s=>s.key.startsWith('agent:'));
 const role=roles[0]?.key.split(':')[1] as AutonomyRole;
 if(roles.length!==1 || !p.agents[role] || roles[0].key!==`agent:${role}:${p.periodId}`
   || !copy.scopes.some(s=>s.key===`job:${copy.jobId}`)
   || copy.scopes.some(s=>s.key.startsWith('autonomous-root:'))) throw new Error('autonomous_budget_scope_required');
 for(const scope of copy.scopes) {
  if(!Number.isSafeInteger(scope.capMicroUsd) || scope.capMicroUsd<0) throw new Error('autonomous_budget_scope_required');
  if(scope.key===roles[0].key) scope.capMicroUsd=Math.min(scope.capMicroUsd,p.roleCapsMicroUsd[role],ROLE_DEFINITIONS[role].periodCapMicroUsd);
 }
 copy.scopes.push({key:`autonomous-root:${p.tenantId}:${p.periodId}`,capMicroUsd:p.rootBudgetMicroUsd});
 return copy;
}

/** Adds root policy scope to the EXISTING atomic SQL reservation, never a second monetary
 * debit. Use this ledger when constructing AgentSessionService. Existing lower caps survive. */
export function createAutonomousBudgetLedger(underlying: BudgetLedger, input: AutonomousPolicy): BudgetLedger {
 const p=createAutonomousPolicy(input);
 return {
  async reserve(request) { return underlying.reserve(scoped(request,p)); },
  settle:(id,cost)=>underlying.settle(id,cost),
 };
}

/** Server-owned policy for target/judge/media accounting adapters that reserve directly
 * through PostgresBudgetLedger in their own transaction. Supply this to their reservation
 * callback. Do NOT additionally wrap that ledger: this request already includes root.
 * All writers must use the same immutable job cap and role period in the same SQL ledger.
 * reservationMicroUsd is an authorized worst-case hold, never a measured price. */
export function createAutonomousPaidReservationPolicy(input: {
 policy: AutonomousPolicy; job: JobRef; role: AutonomyRole;
 jobCapMicroUsd: number; reservationMicroUsd: number;
}): (operation: { operationId: string }) => BudgetReservationRequest {
 const p=createAutonomousPolicy(input.policy),job=JobRefSchema.parse(input.job),role=input.role;
 const jobCap=input.jobCapMicroUsd,hold=input.reservationMicroUsd;
 const ceiling=job.package==='version_comparison'?p.comparisonJobCapMicroUsd:p.singleJobCapMicroUsd;
 if(job.customerId!==p.tenantId || !p.agents[role] || !/^[A-Za-z0-9_-]+$/.test(p.periodId)
   || !Number.isSafeInteger(jobCap) || jobCap<=0 || jobCap>ceiling
   || !Number.isSafeInteger(hold) || hold<=0 || hold>jobCap) throw new Error('autonomous_paid_policy_invalid');
 return ({operationId})=>{
  if(typeof operationId!=='string' || !operationId.length || operationId.length>4096 || /[\u0000\uD800-\uDFFF]/u.test(operationId)) throw new Error('autonomous_paid_operation_invalid');
  return scoped({reservationId:operationId,jobId:job.jobId,amountMicroUsd:hold,scopes:[
   {key:`job:${job.jobId}`,capMicroUsd:jobCap},
   {key:`agent:${role}:${p.periodId}`,capMicroUsd:ROLE_DEFINITIONS[role].periodCapMicroUsd},
  ]},p);
 };
}

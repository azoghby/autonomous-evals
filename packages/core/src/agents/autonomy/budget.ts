import type { BudgetLedger } from '../../evals/types';
import { createAutonomousPolicy, type AutonomousPolicy, type AutonomyRole } from './policy';

/** Adds root policy scope to the EXISTING atomic SQL reservation, never a second monetary
 * debit. Use this ledger when constructing AgentSessionService. Existing lower caps survive. */
export function createAutonomousBudgetLedger(underlying: BudgetLedger, input: AutonomousPolicy): BudgetLedger {
 const p=createAutonomousPolicy(input);
 return {
  async reserve(request) {
   const roleScope=request.scopes.find(s=>s.key.startsWith('agent:'));
   const role=roleScope?.key.split(':')[1] as AutonomyRole;
   if(!p.agents[role] || !request.scopes.some(s=>s.key===`job:${request.jobId}`)) throw new Error('autonomous_budget_scope_required');
   const scopes=request.scopes.map(scope=>({...scope,capMicroUsd:scope.key.startsWith('agent:') ? Math.min(scope.capMicroUsd,p.roleCapsMicroUsd[role]) : scope.capMicroUsd}));
   scopes.push({key:`autonomous-root:${p.tenantId}:${p.periodId}`,capMicroUsd:p.rootBudgetMicroUsd});
   return underlying.reserve({...request,scopes});
  },
  settle:(id,cost)=>underlying.settle(id,cost),
 };
}

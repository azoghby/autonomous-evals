import 'server-only';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { SharedJobBudgetLedger } from '@ae/core/db/job-budget-ledger';
import type { BudgetLedger } from '@ae/core/evals/types';
import { currentWorkflowStageScope, type WorkflowStageScope } from './workflow-stage-runtime';

/** Capture the trusted executing stage at admission time. Settlement deliberately
 * remains available after lease loss so measured provider usage can be reconciled. */
export function createWorkflowStageBudgetLedger(
 sql: AgentTransactionalSql,
 getScope: () => WorkflowStageScope | undefined = currentWorkflowStageScope,
): BudgetLedger {
 const settlement = new SharedJobBudgetLedger(sql);
 return {
  reserve: input => {
   // Expert honoraria have their own obligation ledger and are not stage model children.
   if (input.scopes.some(scope => scope.key.startsWith('expert-'))) return settlement.reserve(input);
   const scope = getScope();
   if (!scope) return settlement.reserve(input);
   scope.assertActive?.();
   const owner = { ...scope.owner };
   const admission: AgentTransactionalSql = {
    query: sql.query.bind(sql),
    transaction: fn => sql.transaction(async tx => {
     scope.assertActive?.();
     const result = await fn(tx);
     // Throw inside the same transaction, before commit, if renewal or execution ended.
     scope.assertActive?.();
     return result;
    }),
   };
   return new SharedJobBudgetLedger(admission, async () => {
    scope.assertActive?.();
    return owner;
   }).reserve(input);
  },
  settle: settlement.settle.bind(settlement),
 };
}

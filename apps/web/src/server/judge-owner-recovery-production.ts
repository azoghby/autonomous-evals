import 'server-only';
import { createClient } from '@usenaive-sdk/managed-agents';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { SharedJobBudgetLedger } from '@ae/core/db/job-budget-ledger';
import { settleCost } from '@ae/core/db/cost-settlement';
import { JOB_BUDGET_MICRO_USD } from '@ae/core/contracts/index';
import { createNaiveProxyBudget } from '@ae/core/judges/naive-proxy-budget';
import { naiveProxyCostEntry } from '@ae/core/judges/naive-proxy-service';
import { expertOwnerDatabase } from '@/server/automated-expert-owner';
import { requireOperator } from '@/server/http';
import type { JudgeAccountingDeps, JudgeOwnerRecoveryDeps } from './judge-owner-recovery';
export interface JudgeAccountingOverrides {
 sql?:AgentTransactionalSql;
 audit?:JudgeAccountingDeps['audit'];
 recordCost?:JudgeAccountingDeps['recordCost'];
}
/** Explicit trusted server capability for already incurred accounting only. No session,
 * entitlement, stage lease, paid factory, or provider creation API is required. */
export function trustedJudgeAccountingDependencies(overrides:JudgeAccountingOverrides={}):JudgeAccountingDeps {
 const sql=overrides.sql??expertOwnerDatabase();
 return {sql,authorizeAccounting:async()=>{},
  audit:overrides.audit??{call:async id=>{const apiKey=process.env.NAIVE_API_KEY;if(!apiKey)throw Error('audit_unconfigured');const client=createClient({apiKey,...(process.env.NAIVE_BASE_URL?{baseUrl:process.env.NAIVE_BASE_URL}:{})});return client.proxy.call(id);}},
  recordCost:overrides.recordCost??(async(job,receipt)=>{await settleCost(sql,{kind:'job',id:job.id,ownerId:job.customer_id,environment:job.environment},naiveProxyCostEntry(receipt,{jobId:job.id,model:receipt.model}));}),
  legacyBudget:job=>{const cap=JOB_BUDGET_MICRO_USD[job.package as keyof typeof JOB_BUDGET_MICRO_USD];return createNaiveProxyBudget(new SharedJobBudgetLedger(sql),{jobId:job.id,period:'recovery',jobCapMicroUsd:cap,judgeCapMicroUsd:cap});},
 };
}
/** Operator surface remains separately authorized; internal accounting grants no recovery authority. */
export function judgeOwnerRecoveryDependencies(overrides:JudgeAccountingOverrides={}):JudgeOwnerRecoveryDeps {
 const currentOperator=async()=>{const auth=await requireOperator();if(auth.res)throw Error('operator_required');return auth.viewer.id;};
 return {...trustedJudgeAccountingDependencies(overrides),currentOperator,authorizeAccounting:async()=>{await currentOperator();}};
}

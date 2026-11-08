import 'server-only';
import { createClient } from '@usenaive-sdk/managed-agents';
import { PostgresBudgetLedger } from '@ae/core/agents/postgres-ports';
import { JOB_BUDGET_MICRO_USD } from '@ae/core/contracts/index';
import { createNaiveProxyBudget } from '@ae/core/judges/naive-proxy-budget';
import { naiveProxyCostEntry } from '@ae/core/judges/naive-proxy-service';
import { expertOwnerDatabase } from '@/server/automated-expert-owner';
import { recordSettledCost } from '@/server/cost-settlement';
import { requireOperator } from '@/server/http';
import type { JudgeOwnerRecoveryDeps } from './judge-owner-recovery';
/** Private capability; the SDK client is enclosed and only audit.call is exported. */
export function judgeOwnerRecoveryDependencies():JudgeOwnerRecoveryDeps {
 const sql=expertOwnerDatabase();
 return {sql,currentOperator:async()=>{const auth=await requireOperator();if(auth.res)throw Error('operator_required');return auth.viewer.id;},
  audit:{call:async id=>{const apiKey=process.env.NAIVE_API_KEY;if(!apiKey)throw Error('audit_unconfigured');const client=createClient({apiKey,...(process.env.NAIVE_BASE_URL?{baseUrl:process.env.NAIVE_BASE_URL}:{})});return client.proxy.call(id);}},
  recordCost:async(job,receipt)=>{await recordSettledCost({kind:'job',id:job.id,ownerId:job.customer_id,environment:job.environment},naiveProxyCostEntry(receipt,{jobId:job.id,model:receipt.model}));},
  legacyBudget:job=>{const cap=JOB_BUDGET_MICRO_USD[job.package as keyof typeof JOB_BUDGET_MICRO_USD];return createNaiveProxyBudget(new PostgresBudgetLedger(sql),{jobId:job.id,period:'recovery',jobCapMicroUsd:cap,judgeCapMicroUsd:cap});},
 };
}

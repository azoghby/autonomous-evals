import { createWorkflowStageBudgetLedger } from './workflow-stage-budget';
import { fenceWorkflowDesignCheckpoints } from './workflow-design-checkpoints';
import { fenceWorkflowStageSessions, fenceWorkflowStageRunner } from './workflow-stage-children';
import 'server-only';
import { createHash,randomUUID } from 'node:crypto';
import { createClient } from '@usenaive-sdk/managed-agents';
import type { AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { PostgresAgentTaskStore } from '@ae/core/agents/postgres-ports';
import { COMPANY_ROLE_DEFINITIONS } from '@ae/core/agents/company-roles';
import { ROLE_DEFINITIONS,TASK_BUDGETS } from '@ae/core/agents/roles';
import { createNaiveClient,createNaiveSessionsPort } from '@ae/core/agents/naive-adapter';
import { AgentSessionService,type AgentTaskRunner } from '@ae/core/agents/session-service';
import type { EvalServices,ServiceContext } from '@ae/core/contracts/services';
import { JOB_BUDGET_MICRO_USD } from '@ae/core/contracts/index';
import { inspectDataSafety } from '@ae/core/evals/data/quality';
import { CostEntrySchema,type Clock,type BudgetLedger,type AgentDirectory } from '@ae/core/evals/types';
import { createTextEvaluationServices } from '@ae/core/evals/integration/services';
import { createNaiveDesignService } from '@ae/core/evals/naive-design-service';
import { createNaiveRunService } from '@ae/core/evals/naive-run-service';
import { createNaiveInvestigationService } from '@ae/core/evals/naive-investigation-service';
import { canonicalJson } from '@ae/core/evals/text/freeze';
import { TrackBBlockedError,toContractCost } from '@ae/core/evals/service-adapter';
import { createTextTarget } from '@ae/core/targets/text';
import type { JsonTransport } from '@ae/core/targets/transport';
import { createNaiveProxyServiceJudge } from '@ae/core/judges/naive-proxy-service';
import { createNaiveProxyBudget } from '@ae/core/judges/naive-proxy-budget';
import { LEGACY_EXECUTION_PROFILE,retainedNaiveExecutionProfile,createNaiveMethodAuthority } from './naive-method-authority';
import { createNaiveEngineAdmissionPolicy } from './naive-engine-admission-policy';

import type { NaiveTextExecutionProfile } from './naive-text-execution-selection';
export type NaiveTextMethod='designSuite'|'runSuite'|'investigate';
export type NaiveMethod=NaiveTextMethod|'proposeAndVerifyFix'|'rerunFinding';
type ContractCost=Parameters<ServiceContext['recordCost']>[0];
const hash=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const fail=(message='Generic Naive text configuration or current authority unavailable.'):never=>{throw new TrackBBlockedError('rejected_input',message);};
export interface NaiveTextMethodsDependencies {
 sql?:AgentTransactionalSql;
 executionProfile?:NaiveTextExecutionProfile;
 runnerFactory?:(ledger:BudgetLedger)=>AgentTaskRunner;
 clock?:Clock;
 targetTransport?:JsonTransport;
 remediationTransport?:JsonTransport;
 proxyFetch?:typeof fetch;
 decryptCredentials?:(ciphertext:string)=>Record<string,string>;
}
interface CostEnvelope {jobId:string;customerId:string;environment:'test'|'live';cost:ContractCost}
/** Internal composition of existing durable services, never an alternate job Workflow. */
export async function createNaiveTextRuntime(ctx:ServiceContext,deps:NaiveTextMethodsDependencies={}) {
 if(!Number.isSafeInteger(ctx.budgetMicroUsd)||ctx.budgetMicroUsd<=0)throw new TrackBBlockedError('paused_budget','Positive safe integer Naive budget required before constructing providers.');
 const sql=deps.sql??(await import('@/server/automated-expert-owner')).expertOwnerDatabase();
 const jobId=ctx.jobId,environment=ctx.environment;
 const profile=structuredClone(deps.executionProfile??LEGACY_EXECUTION_PROFILE);
 const cap=JOB_BUDGET_MICRO_USD.text_eval;
 // Cost reconciliation is independent from current dispatch/review permission. Owner and
 // environment still must match the original durable binding before a retained receipt is delivered.
 async function deliver(envelope:CostEnvelope){
  await sql.transaction(async tx=>{
  const selected=await retainedNaiveExecutionProfile(tx,jobId);
  const owner=(await tx.query<{customer_id:string;environment:string}>('SELECT customer_id::text,environment FROM jobs WHERE id=$1',[jobId])).rows[0];
  const binding=(await tx.query<{value:{job:{jobId:string;customerId:string;environment:string}};state:string;input_digest:string}>(`SELECT value,state,input_digest FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_method_binding' AND id=$2`,[jobId,selected.designId])).rows[0];
  if(!owner||!binding||binding.state!=='completed'||binding.input_digest!==hash(binding.value)||envelope.jobId!==jobId||envelope.environment!==environment||owner.environment!==environment||owner.customer_id!==envelope.customerId||binding.value.job.customerId!==envelope.customerId||binding.value.job.jobId!==jobId||binding.value.job.environment!==environment)return fail();
  });
  await ctx.recordCost(envelope.cost);
 }
 const retainedCosts=await sql.query<{value:CostEnvelope;input_digest:string}>(`SELECT value,input_digest FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_generic_cost' AND state='completed' ORDER BY id LIMIT 1001`,[jobId]);
 if(retainedCosts.rows.length>1000)return fail();
 for(const receipt of retainedCosts.rows){if(receipt.input_digest!==hash(receipt.value))return fail();await deliver(receipt.value);}
 const authority=await createNaiveMethodAuthority(ctx,{sql,...createNaiveEngineAdmissionPolicy(profile),executionProfile:profile,decryptCredentials:deps.decryptCredentials});
 const first=await authority.current();
 async function retainCost(cost:ContractCost){
  if(!Number.isSafeInteger(cost.microUsd)||cost.microUsd<0||!cost.meta?.measured||typeof cost.meta.idempotencyKey!=='string'||!cost.meta.idempotencyKey||!['naive','naive_proxy'].includes(cost.source))return fail('Measured keyed Naive cost required.');
  const envelope:CostEnvelope={jobId,customerId:first.job.customerId,environment,cost};
  // This must succeed after provider completion even if dispatch permission was revoked.
  if(!inspectDataSafety(envelope,first.secrets).safe)return fail();
  const id=hash(cost.meta.idempotencyKey),digest=hash(envelope);
  await sql.transaction(async tx=>{
   if(canonicalJson(await retainedNaiveExecutionProfile(tx,jobId))!==canonicalJson(profile))return fail();
   await tx.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_generic_cost',$2,$3,$4,'completed',$5::jsonb) ON CONFLICT DO NOTHING`,[jobId,id,digest,randomUUID(),JSON.stringify(envelope)]);
   const row=(await tx.query<{input_digest:string;state:string;value:unknown}>(`SELECT input_digest,state,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_generic_cost' AND id=$2 FOR UPDATE`,[jobId,id])).rows[0];
   if(!row||row.input_digest!==digest||row.state!=='completed'||canonicalJson(row.value)!==canonicalJson(envelope))return fail();
  });return envelope;
 }
 // Persist the initial authorized allocation once. Remaining Workflow budget changes on a
 // retry must never change an existing task's provider request or durable task identity.
 await authority.current();
 const allocation=await sql.transaction(async tx=>{
  if(canonicalJson(await retainedNaiveExecutionProfile(tx,jobId))!==canonicalJson(profile))return fail();
  await tx.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_generic_budget',$5,$2,$3,'completed',$4::jsonb) ON CONFLICT DO NOTHING`,[jobId,hash(first.binding),randomUUID(),JSON.stringify({bindingDigest:hash(first.binding),budgetMicroUsd:Math.min(ctx.budgetMicroUsd,cap)}),profile.designId]);
  const row=(await tx.query<{input_digest:string;state:string;value:{bindingDigest:string;budgetMicroUsd:number}}>(`SELECT input_digest,state,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_generic_budget' AND id=$2 FOR UPDATE`,[jobId,profile.designId])).rows[0];
  if(!row||row.state!=='completed'||row.input_digest!==hash(first.binding)||row.value.bindingDigest!==hash(first.binding)||!Number.isSafeInteger(row.value.budgetMicroUsd)||row.value.budgetMicroUsd<=0||row.value.budgetMicroUsd>cap)return fail();
  return row.value.budgetMicroUsd;
 });
 const model=process.env.NAIVE_JUDGE_MODEL,proxyKey=process.env.NAIVE_API_KEY,baseUrl=process.env.NAIVE_BASE_URL;
 const reservation=Number(process.env.NAIVE_JUDGE_RESERVATION_MICRO_USD),output=Number(process.env.NAIVE_JUDGE_MAX_OUTPUT_TOKENS);
 if(!model?.trim()||model!==model.trim()||!proxyKey||!Number.isSafeInteger(reservation)||reservation<=0||!Number.isSafeInteger(output)||output<=0)return fail('Configured Naive judge model and bounded proxy policy required.');
 const stableContext=(input:ServiceContext):ServiceContext=>{
  if(input.jobId!==jobId||input.environment!==environment||!Number.isSafeInteger(input.budgetMicroUsd)||input.budgetMicroUsd<=0)return fail();
  return {...input,budgetMicroUsd:allocation,recordCost:async cost=>{const retained=await retainCost(cost);await deliver(retained);}};
 };
 const stable=stableContext(ctx);
 const rawLedger=createWorkflowStageBudgetLedger(sql);
 // A third scope is appended to the SAME reservation as canonical role/job scopes.
 // This bounds the initial allowance without changing shared caps or double-counting spend.
 const ledger:BudgetLedger={reserve:input=>{
  if(input.jobId!==jobId||input.scopes.some(s=>s.key.startsWith('generic-text:')))return fail();
  return rawLedger.reserve({...input,scopes:[...input.scopes,{key:profile.policyId==='generic-text-v1'?`generic-text:${jobId}`:`generic-text:${profile.policyId}:${jobId}`,capMicroUsd:allocation}]});
 },settle:rawLedger.settle.bind(rawLedger)};
 function defaultRunner():AgentTaskRunner {
  const roles={commercial:'COMMERCIAL',evaluation_engineer:'EVALUATION_ENGINEER',quality_investigator:'QUALITY_INVESTIGATOR',company_operator:'COMPANY_OPERATOR'} as const;
  const directory=Object.fromEntries(Object.entries(roles).map(([role,suffix])=>{
   const match=/^([A-Za-z0-9_-]+)@([1-9]\d*)$/.exec(process.env[`NAIVE_AGENT_${suffix}`]??'');
   if(!match||!Number.isSafeInteger(Number(match[2])))return fail('All four Naive agent role versions must be configured and pinned.');
   return [role,{agentId:match[1],agentVersion:Number(match[2])}];
  })) as AgentDirectory;
  return new AgentSessionService({naive:fenceWorkflowStageSessions(createNaiveSessionsPort(createNaiveClient({apiKey:proxyKey!,...(baseUrl?{baseUrl}: {})}))),store:new PostgresAgentTaskStore(sql),ledger,directory,
   budgetPeriodId:process.env.NAIVE_BUDGET_PERIOD_ID||new Date().toISOString().slice(0,7),idempotencyNamespace:process.env.VERCEL_ENV||process.env.NODE_ENV||'development',workerId:randomUUID()});
 }
 const rawRunner=fenceWorkflowStageRunner(deps.runnerFactory?deps.runnerFactory(ledger):defaultRunner());
 const runner:AgentTaskRunner={run:async spec=>{
  await authority.current();
  if(spec.job.jobId!==jobId||spec.job.environment!==environment||spec.budgetMicroUsd!==allocation)return fail();
  // AgentSessionService's aggregate SQL budget ledger reserves against the job cap and
  // resumes already reserved completed tasks without a second reservation.
  const selected=spec.output.name==='text_design'?TASK_BUDGETS.suiteDesign:spec.output.name==='text_review'?TASK_BUDGETS.suiteReview:TASK_BUDGETS.traceRecheck;
  const taskId=hash({role:spec.role,purpose:spec.purpose});
  const taskBudget=await sql.transaction(async tx=>{
   if(canonicalJson(await retainedNaiveExecutionProfile(tx,jobId))!==canonicalJson(profile))return fail();
   const original=Math.min(allocation,selected,ROLE_DEFINITIONS[spec.role].maxTaskMicroUsd);
   await tx.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES($1,'naive_generic_task_budget',$2,$3,$4,'completed',$5::jsonb) ON CONFLICT DO NOTHING`,[jobId,taskId,hash({binding:first.binding,role:spec.role,purpose:spec.purpose}),randomUUID(),JSON.stringify({budgetMicroUsd:original})]);
   const row=(await tx.query<{input_digest:string;state:string;value:{budgetMicroUsd:number}}>(`SELECT input_digest,state,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_generic_task_budget' AND id=$2 FOR UPDATE`,[jobId,taskId])).rows[0];
   if(!row||row.state!=='completed'||row.input_digest!==hash({binding:first.binding,role:spec.role,purpose:spec.purpose})||!Number.isSafeInteger(row.value.budgetMicroUsd)||row.value.budgetMicroUsd<=0||row.value.budgetMicroUsd>allocation||row.value.budgetMicroUsd>ROLE_DEFINITIONS[spec.role].maxTaskMicroUsd)return fail();
   return row.value.budgetMicroUsd;
  });
  await authority.current();
  const result=await rawRunner.run({...spec,budgetMicroUsd:taskBudget,jobCapMicroUsd:cap});
  if('cost' in result&&result.cost){const parsed=CostEntrySchema.parse(result.cost);if(parsed.jobId!==jobId)return fail();await retainCost(toContractCost(parsed));}
  await authority.current(result);return result;
 }};
 const proxyBudget=createNaiveProxyBudget(ledger,{jobId,period:process.env.NAIVE_BUDGET_PERIOD_ID||new Date().toISOString().slice(0,7),jobCapMicroUsd:cap,judgeCapMicroUsd:COMPANY_ROLE_DEFINITIONS.judge.monthlyMicroUsd});
 const judge=createNaiveProxyServiceJudge(stable,{jobId,model,maxOutputTokens:output,reservationMicroUsd:reservation,checkpoints:authority.checkpoints,
  budget:proxyBudget,
  client:idempotencyKey=>createClient({apiKey:proxyKey,...(baseUrl?{baseUrl}:{}),idempotencyKey:()=>idempotencyKey,fetch:deps.proxyFetch}),
  authorize:async()=>{const fresh=await authority.current();if(process.env.NAIVE_JUDGE_MODEL!==model||process.env.NAIVE_API_KEY!==proxyKey||process.env.NAIVE_BASE_URL!==baseUrl||Number(process.env.NAIVE_JUDGE_RESERVATION_MICRO_USD)!==reservation||Number(process.env.NAIVE_JUDGE_MAX_OUTPUT_TOKENS)!==output)return fail();return {knownSecrets:fresh.secrets};}});
 async function targetDependencies(){
  const a=await authority.current(),secured=createTextTarget(a.target,deps.targetTransport);
  return {...a,knownSecrets:a.secrets,judge,target:{send:async(request:Parameters<typeof secured.send>[0])=>{await authority.current();return secured.send(request);}}};
 }
 const designRich=createTextEvaluationServices({runner,checkpoints:fenceWorkflowDesignCheckpoints(authority.checkpoints),clock:deps.clock,resolve:targetDependencies});
 const design=createNaiveDesignService({...('factualGapPolicy' in profile?{factualGapPolicy:profile.factualGapPolicy}:{}),engine:designRich,admission:authority.artifacts.admission,authorize:authority.authorizeDesign});
 async function resolved(){const a=await authority.resolveSuite(),ports=await targetDependencies();return {...ports,...a,knownSecrets:a.secrets,canonicalTarget:a.target,target:ports.target,judge};}
 const run=createNaiveRunService({runner,checkpoints:authority.checkpoints,clock:deps.clock,resolve:resolved,persistRun:authority.artifacts.persistRun});
 const investigation=createNaiveInvestigationService({runner,checkpoints:authority.checkpoints,clock:deps.clock,resolve:async()=>{
  const a=await resolved(),retainedRun=await authority.artifacts.loadRun(stable,a.scope,a.runId,a.targetVersion);if(!retainedRun)return fail();return {...a,retainedSuite:a.retained,retainedRun};
 },persistInvestigation:authority.artifacts.persistInvestigation});
 const methods:Pick<EvalServices,NaiveTextMethod>={
  designSuite:(input,intake)=>design.designSuite(stableContext(input),intake),
  runSuite:(input,suite,target,branch)=>run.runSuite(stableContext(input),suite,target,branch),
  investigate:(input,suite,runs)=>investigation.investigate(stableContext(input),suite,runs),
 };
 return {sql,profile,authority,stableContext,runner,judge,ledger,targetDependencies,resolved,methods,allocation,cap,allocationScope:profile.policyId==='generic-text-v1'?`generic-text:${jobId}`:`generic-text:${profile.policyId}:${jobId}`};
}
export async function createNaiveTextMethods(ctx:ServiceContext,deps:NaiveTextMethodsDependencies={}):Promise<Pick<EvalServices,NaiveTextMethod>> {
 return (await createNaiveTextRuntime(ctx,deps)).methods;
}
export type NaiveTextRuntime=Awaited<ReturnType<typeof createNaiveTextRuntime>>;
/** Routing installs this builder lazily. Unsupported trial/rerun semantics stay unavailable. */
export function createNaiveTextMethodBuilder(deps:NaiveTextMethodsDependencies={}){
 return async(method:NaiveMethod,ctx:ServiceContext):Promise<Partial<Pick<EvalServices,NaiveMethod>>>=>{
  if(method==='proposeAndVerifyFix')return (await import('./naive-remediation-runtime')).createNaiveRemediationMethods(ctx,deps);
  if(!['designSuite','runSuite','investigate'].includes(method))return fail('Generic Naive remediation/rerun requires its own owner runtime.');
  return createNaiveTextMethods(ctx,deps);
 };
}

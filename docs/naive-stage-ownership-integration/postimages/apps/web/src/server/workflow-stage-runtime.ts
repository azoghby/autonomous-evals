import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { getWorkflowMetadata, getStepMetadata, RetryableError } from 'workflow';
import { encryptJson, decryptJson } from '@ae/core/storage/crypto';
import { jobBudgetExposure, type JobBudgetTx } from '@ae/core/db/job-budget-authority';
import { claimWorkflowStage, recoverWorkflowStage, assertWorkflowStageOwner, completeWorkflowStage, markWorkflowStagePending } from '@ae/core/db/workflow-stage-authority';

import { workflowStageRecoveryReader } from './workflow-stage-children';

type Owner = Parameters<typeof assertWorkflowStageOwner>[1];
export interface WorkflowStageScope { owner: Owner; transaction: typeof workflowStageTransaction }
let scopes: AsyncLocalStorage<WorkflowStageScope> | undefined;
function stageScopes() { return scopes ??= new AsyncLocalStorage<WorkflowStageScope>(); }
/** Trusted server capability only. Never serialize into Workflow I/O or model prompts. */
export function currentWorkflowStageScope(): WorkflowStageScope | undefined { return stageScopes().getStore(); }
export async function assertWorkflowStageCurrent(): Promise<void> {
 const scope=stageScopes().getStore();
 if(scope) await scope.transaction(tx=>assertWorkflowStageOwner(tx,scope.owner));
}
let pool: Pool | undefined;
export async function workflowStageTransaction<T>(fn:(tx:JobBudgetTx)=>Promise<T>):Promise<T> {
 const connectionString=process.env.DATABASE_URL_UNPOOLED??process.env.DATABASE_URL;
 if(!connectionString)throw new Error('workflow_stage_database_unavailable');
 pool ??= new Pool({connectionString,max:5});
 const connection=await pool.connect(); let discard:Error|undefined;
 try {
  await connection.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  const tx:JobBudgetTx={query:async <R>(text:string,params?:unknown[])=>({rows:(await connection.query(text,params)).rows as R[]})};
  const result=await fn(tx);
  try { await connection.query('COMMIT'); } catch(error) {discard=new Error('workflow_stage_commit_uncertain');throw error;}
  return result;
 } catch(error) {try{await connection.query('ROLLBACK');}catch{discard=new Error('workflow_stage_rollback_failed');}throw error;}
 finally{connection.release(discard);}
}
function canonical(value:unknown):string {
 if(value===undefined)return 'null';
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 return `{${Object.keys(value).sort().filter(k=>(value as Record<string,unknown>)[k]!==undefined).map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`;
}
export function workflowStageDigest(input:unknown):string {return createHash('sha256').update(canonical(input)).digest('hex');}
export class WorkflowStageContentionError extends RetryableError {
 constructor(readonly reason:'busy'|'recovery_required'){super(`Workflow stage ${reason}`,{retryAfter:'5s'});this.name='WorkflowStageContentionError';}
}
/** Recovery is opt-in only after ALL callback side effects have retained child authority.
 * Current mixed Naive/lite/target callbacks intentionally stay held after interruption. */
export interface LogicalWorkflowStage {key:string;input:unknown;recovery?:'retained-children';isPending?:(value:unknown)=>boolean;isPendingError?:(error:unknown)=>boolean}
export async function executeWorkflowStage<T>(input:{jobId:string;ownerId:string;environment:'test'|'live';role:string;share:number;stage:LogicalWorkflowStage},run:(amountMicroUsd:number)=>Promise<T>):Promise<{ok:true;data:T}|{ok:false;remainingMicroUsd:number}> {
 const inputDigest=workflowStageDigest(input.stage.input);
 const step=getStepMetadata();
 const invocation={workflowRunId:getWorkflowMetadata().workflowRunId,stepId:step.stepId,attempt:step.attempt};
 const admission=await workflowStageTransaction(async tx=>{
  const exposure=await jobBudgetExposure(tx,input.jobId);
  const claim={jobId:input.jobId,ownerId:input.ownerId,environment:input.environment,stageKey:input.stage.key,inputDigest,role:input.role,amountMicroUsd:Math.floor(exposure.capMicroUsd*input.share),invocation,leaseMs:300_000};
  const decision=await claimWorkflowStage(tx,claim);
  return decision.kind==='recovery_required' && input.stage.recovery==='retained-children'
   ? recoverWorkflowStage(tx,claim,workflowStageRecoveryReader) : decision;
 });
 if(admission.kind==='budget_exceeded')return {ok:false,remainingMicroUsd:admission.remainingMicroUsd};
 if(admission.kind==='busy'||admission.kind==='recovery_required')throw new WorkflowStageContentionError(admission.kind);
 if(admission.kind==='completed') {
  const retained=decryptJson<{schema:number;jobId:string;stageKey:string;inputDigest:string;data:T}>(admission.resultCiphertext);
  if(retained.schema!==1||retained.jobId!==input.jobId||retained.stageKey!==input.stage.key||retained.inputDigest!==inputDigest)throw new Error('workflow_stage_result_binding');
  return {ok:true,data:retained.data};
 }
 if(admission.kind!=='owned')throw new Error('workflow_stage_invalid_admission');
 return stageScopes().run({owner:admission.owner,transaction:workflowStageTransaction},async()=>{
  let data:T;
  try {data=await run(admission.amountMicroUsd);} catch(error) {
   if(input.stage.isPendingError?.(error))await workflowStageTransaction(tx=>markWorkflowStagePending(tx,admission.owner));
   throw error;
  }
  if(input.stage.isPending?.(data))await workflowStageTransaction(tx=>markWorkflowStagePending(tx,admission.owner));
  else await workflowStageTransaction(tx=>completeWorkflowStage(tx,admission.owner,encryptJson({schema:1,jobId:input.jobId,stageKey:input.stage.key,inputDigest,data})));
  return {ok:true as const,data};
 });
}

import type { NaiveSessionsPort, NaiveSessionCreateBody, AgentTaskRecord } from '@ae/core/evals/types';
import { NaiveCallError } from '@ae/core/evals/types';
import { assertWorkflowStageOwner, registerWorkflowStageChild, markWorkflowStageChildDispatch, type WorkflowStageRecoveryReader } from '@ae/core/db/workflow-stage-authority';
import type { JobBudgetTx } from '@ae/core/db/job-budget-authority';
import { currentWorkflowStageScope, workflowStageDigest, type WorkflowStageScope } from './workflow-stage-runtime';

const KIND='naive_session';
const refuse=():never=>{throw new NaiveCallError('ambiguous','workflow_stage_child_reconciliation_required');};
function childIdentity(record:AgentTaskRecord){return {kind:KIND,operationKey:record.taskKey,requestDigest:workflowStageDigest({idempotencyKey:record.idempotencyKey,requestBody:record.requestBody})};}
async function retained(tx:JobBudgetTx,key:string):Promise<AgentTaskRecord|undefined>{
 return (await tx.query<{record:AgentTaskRecord}>('SELECT record FROM agent_persistence.tasks WHERE task_key=$1',[key])).rows[0]?.record;
}
/** Decorate at buildAgentDeps, before constructing AgentSessionService. Reads and measured
 * receipt writes remain the existing protocol's responsibility, including after ownership loss.
 * Intent commits before provider I/O. An already authorized request may finish after takeover;
 * its immutable same-key receipt is evidence, never publication permission. */
export function fenceWorkflowStageSessions(port:NaiveSessionsPort,getScope:()=>WorkflowStageScope|undefined=currentWorkflowStageScope):NaiveSessionsPort {
 return {
  getSession:id=>port.getSession(id),
  listAgentSessions:(agent,page)=>port.listAgentSessions(agent,page),
  async createSession(body:NaiveSessionCreateBody,idempotencyKey:string){
   const scope=getScope();if(!scope)return port.createSession(body,idempotencyKey);
   try {
    await scope.transaction(async tx=>{
     await assertWorkflowStageOwner(tx,scope.owner);
     const taskKey=body.metadata?.ae_task_key;
     if(typeof taskKey!=='string')return refuse();
     const record=await retained(tx,taskKey);
     if(!record||record.taskKey!==taskKey||record.jobId!==scope.owner.jobId||body.metadata.ae_job_id!==scope.owner.jobId||record.idempotencyKey!==idempotencyKey||workflowStageDigest(record.requestBody)!==workflowStageDigest(body)||!['creating','ambiguous'].includes(record.state))return refuse();
     const child=childIdentity(record);
     await registerWorkflowStageChild(tx,scope.owner,child);
     const prior=(await tx.query<{dispatch_intent_at:unknown}>('SELECT dispatch_intent_at FROM workflow_stage.children WHERE job_id=$1 AND stage_key=$2 AND kind=$3 AND operation_key=$4',[scope.owner.jobId,scope.owner.stageKey,KIND,taskKey])).rows[0];
     // Existing dispatch can only replay the exact immutable task/body/key through
     // AgentSessionService's bounded ambiguous-create recovery, never a fresh child.
     if(!prior?.dispatch_intent_at)await markWorkflowStageChildDispatch(tx,scope.owner,child);
    });
   }catch{ return refuse(); }
   return port.createSession(body,idempotencyKey);
  },
 };
}
/** The actual publication write must use tx; a callback that uses another pooled
 * connection does not satisfy this contract. No network/provider calls inside it. */
export async function publishWorkflowStage<T>(write:(tx:JobBudgetTx)=>Promise<T>,scope:WorkflowStageScope|undefined=currentWorkflowStageScope()):Promise<T>{
 if(!scope)throw Error('workflow_stage_scope_required');
 return scope.transaction(async tx=>{await assertWorkflowStageOwner(tx,scope.owner);return write(tx);});
}
/** Trusted SQL evidence reader: no caller-provided timeout/boolean establishes recovery.
 * Lite/Gateway/target children have no durable recoverable protocol here and stay held. */
export const workflowStageRecoveryReader:WorkflowStageRecoveryReader={async read(tx,child){
 const unknown={state:'unknown' as const,evidenceKey:`unverified:${child.kind}:${child.operationKey}`};
 if(child.kind!==KIND)return unknown;
 const record=await retained(tx,child.operationKey);
 if(!record||record.jobId!==child.jobId||record.taskKey!==child.operationKey||record.requestBody?.metadata?.ae_job_id!==child.jobId||record.requestBody?.metadata?.ae_task_key!==child.operationKey||!record.idempotencyKey||childIdentity(record).requestDigest!==child.requestDigest)return unknown;
 const evidenceKey=`agent_persistence.tasks:${record.taskKey}:revision:${record.revision}`;
 if(['creating','ambiguous'].includes(record.state))return {state:'resumable',evidenceKey};
 if(record.state==='created'&&record.sessionId)return {state:'resumable',evidenceKey};
 if(record.state==='completed'&&record.sessionId&&record.result!==null&&Number.isSafeInteger(record.consumedMicroUsd)&&record.consumedMicroUsd!>=0)return {state:'terminal',evidenceKey};
 return {...unknown,evidenceKey};
}};

/** Associate existing completed/pending tasks even when runner.run needs no create.
 * Core runner still verifies full request/schema/agent identity before stored-result reuse. */
export function fenceWorkflowStageRunner(runner:import('@ae/core/agents/session-service').AgentTaskRunner,getScope:()=>WorkflowStageScope|undefined=currentWorkflowStageScope):import('@ae/core/agents/session-service').AgentTaskRunner {
 return {run:async spec=>{
  const scope=getScope();if(!scope)return runner.run(spec);
  if(spec.job.jobId!==scope.owner.jobId)return refuse();
  const taskKey=`${spec.job.jobId}:${spec.role}:${spec.purpose}:${spec.attempt??1}`;
  async function associate(){await scope!.transaction(async tx=>{
   await assertWorkflowStageOwner(tx,scope!.owner);
   const record=await retained(tx,taskKey);
   if(!record){
    const stage=(await tx.query<{recovery:boolean}>('SELECT recovery FROM workflow_stage.stages WHERE job_id=$1 AND stage_key=$2',[scope!.owner.jobId,scope!.owner.stageKey])).rows[0];
    if(stage?.recovery)return refuse();
    return;
   }
   if(record.taskKey!==taskKey||record.jobId!==scope!.owner.jobId||record.requestBody?.metadata?.ae_task_key!==taskKey||record.requestBody?.metadata?.ae_job_id!==scope!.owner.jobId)return refuse();
   await registerWorkflowStageChild(tx,scope!.owner,childIdentity(record));
  });}
  await associate();const result=await runner.run(spec);await associate();return result;
 }};
}

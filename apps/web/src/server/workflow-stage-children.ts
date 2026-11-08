import { taskKeyFor } from '@ae/core/agents/session-service';
import type { NaiveSessionsPort, NaiveSessionCreateBody, AgentTaskRecord } from '@ae/core/evals/types';
import { NaiveCallError } from '@ae/core/evals/types';
import { assertWorkflowStageOwner, registerWorkflowStageChild, markWorkflowStageChildDispatch, workflowStageDesignSlot, type WorkflowStageChildPlan, type WorkflowStageRecoveryReader } from '@ae/core/db/workflow-stage-authority';
import type { JobBudgetTx } from '@ae/core/db/job-budget-authority';
import { currentWorkflowStageScope, workflowStageDigest, type WorkflowStageScope } from './workflow-stage-runtime';

import { workflowRunRecoveryReader } from './workflow-run-checkpoints';
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
   scope.assertActive?.();
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
 if(['text_run_target','text_run_judge'].includes(child.kind))return workflowRunRecoveryReader.read(tx,child);
 if(child.kind!==KIND)return unknown;
 const record=await retained(tx,child.operationKey);
 if(!record||record.jobId!==child.jobId||record.taskKey!==child.operationKey||record.requestBody?.metadata?.ae_job_id!==child.jobId||record.requestBody?.metadata?.ae_task_key!==child.operationKey||!record.idempotencyKey||childIdentity(record).requestDigest!==child.requestDigest)return unknown;
 const evidenceKey=`agent_persistence.tasks:${record.taskKey}:revision:${record.revision}`;
 if(['creating','ambiguous'].includes(record.state))return {state:'resumable',evidenceKey};
 if(record.state==='created'&&record.sessionId)return {state:'resumable',evidenceKey};
 if(['schema_failed','budget_paused','failed','needs_operator'].includes(record.state)&&record.sessionId&&Number.isSafeInteger(record.consumedMicroUsd)&&record.consumedMicroUsd!>=0&&record.error&&record.leaseOwner===null&&record.leaseExpiresAt===null)return {state:'terminal',evidenceKey};
 if(record.state==='failed'&&!record.sessionId&&record.error&&record.leaseOwner===null&&record.leaseExpiresAt===null){
  const settlement=(await tx.query<{settled_micro_usd:string|number|null}>('SELECT settled_micro_usd FROM agent_persistence.reservations WHERE id=$1 AND job_id=$2',[record.reservationId,record.jobId])).rows[0];
  if(settlement?.settled_micro_usd!==null&&settlement?.settled_micro_usd!==undefined&&Number(settlement.settled_micro_usd)===0)return {state:'terminal',evidenceKey};
 }
 if(record.state==='completed'&&record.sessionId&&record.result!==null&&Number.isSafeInteger(record.consumedMicroUsd)&&record.consumedMicroUsd!>=0)return {state:'terminal',evidenceKey};
 return {...unknown,evidenceKey};
}};

/** Associate existing completed/pending tasks even when runner.run needs no create.
 * Core runner still verifies full request/schema/agent identity before stored-result reuse. */
export function fenceWorkflowStageRunner(runner:import('@ae/core/agents/session-service').AgentTaskRunner,getScope:()=>WorkflowStageScope|undefined=currentWorkflowStageScope):import('@ae/core/agents/session-service').AgentTaskRunner {
 return {run:async spec=>{
  const scope=getScope();if(!scope)return runner.run(spec);
  if(spec.job.jobId!==scope.owner.jobId)return refuse();
  const taskKey=taskKeyFor(spec.job.jobId,spec.role,spec.purpose,spec.attempt??1);
  async function associate(){await scope!.transaction(async tx=>{
   await assertWorkflowStageOwner(tx,scope!.owner);
   const stage=(await tx.query<{recovery:boolean;recovery_profile:string;expected_child_key:string|null;expected_child_plan:WorkflowStageChildPlan|null}>('SELECT recovery,recovery_profile,expected_child_key,expected_child_plan FROM workflow_stage.stages WHERE job_id=$1 AND stage_key=$2',[scope!.owner.jobId,scope!.owner.stageKey])).rows[0];
   if(stage?.recovery_profile==='naive-single-child-v1'&&stage.expected_child_key!==taskKey)return refuse();
   if(stage?.recovery_profile==='naive-design-v1'&&(!stage.expected_child_plan||!workflowStageDesignSlot(scope!.owner.jobId,stage.expected_child_plan,{kind:KIND,operationKey:taskKey,requestDigest:'pending'})))return refuse();
   const record=await retained(tx,taskKey);
   if(!record){
    if(stage?.recovery&&!['naive-single-child-v1','naive-design-v1'].includes(stage.recovery_profile))return refuse();
    return;
   }
   if(record.taskKey!==taskKey||record.jobId!==scope!.owner.jobId||record.requestBody?.metadata?.ae_task_key!==taskKey||record.requestBody?.metadata?.ae_job_id!==scope!.owner.jobId)return refuse();
   await registerWorkflowStageChild(tx,scope!.owner,childIdentity(record));
  });}
  await associate();scope.assertActive?.();const result=await runner.run(spec);await associate();return result;
 }};
}

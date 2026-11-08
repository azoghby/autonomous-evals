import { randomUUID } from 'node:crypto';
import { PostgresTextCheckpointStore, type TextCheckpointStore, type CheckpointKey, type CheckpointLookup } from '@ae/core/evals/integration/checkpoints';
import type { AgentSqlExecutor } from '@ae/core/agents/postgres-ports';
import { assertWorkflowStageOwner, registerWorkflowStageChild, markWorkflowStageChildDispatch, type WorkflowStageRecoveryReader } from '@ae/core/db/workflow-stage-authority';
import { retainedProxyReservation } from '@ae/core/db/job-budget-authority';
import { proxyBillingDigest } from '@ae/core/judges/naive-proxy-reconcile';
import { currentWorkflowStageScope, workflowStageDigest, type WorkflowStageScope } from './workflow-stage-runtime';

type Plan={profile:'naive-text-run-v1';runId:string;suiteDigest:string;targetVersion:string;environment:string;children:{kind:string;operationKey:string}[]};
type Association={stage_key:string;generation:number|string;token:string;input_digest:string;outer_id:string;outer_digest:string};
type Row={state:string;token:string;input_digest:string;value:unknown};
const fail=():never=>{throw Error('workflow_run_checkpoint_conflict');};
const params=(k:CheckpointLookup)=>[k.jobId,k.kind,k.id];
const childKind=(kind:string)=>kind==='target'?'text_run_target':kind==='judge'?'text_run_judge':null;
function allowed(k:CheckpointLookup,p:Plan){
 if(['run_identity','run_result'].includes(k.kind))return k.id===p.runId;
 if(k.kind==='scenario')return p.children.some(c=>c.kind==='text_run_target'&&c.operationKey===k.id);
 const kind=childKind(k.kind);return !!kind&&p.children.some(c=>c.kind===kind&&c.operationKey===k.id);
}
/** Only this mounted generic run protocol may reclaim safe outer memoization. Target
 * dispatch claims never expire, and provider attempt/mode checkpoints are untouched. */
export function fenceWorkflowRunCheckpoints(store:TextCheckpointStore,getScope:()=>WorkflowStageScope|undefined=currentWorkflowStageScope):TextCheckpointStore {
 async function guarded<T>(k:CheckpointLookup,action:(inner:TextCheckpointStore,tx:AgentSqlExecutor,s:WorkflowStageScope,p:Plan|null)=>Promise<T>,fallback:()=>Promise<T>){
  const s=getScope();if(!s)return fallback();
  return s.transaction(async tx=>{await assertWorkflowStageOwner(tx,s.owner);if(k.jobId!==s.owner.jobId)return fail();
   const stage=(await tx.query<{recovery_profile:string;expected_child_plan:Plan|null}>('SELECT recovery_profile,expected_child_plan FROM workflow_stage.stages WHERE job_id=$1 AND stage_key=$2',[k.jobId,s.owner.stageKey])).rows[0];
   const p=stage?.recovery_profile==='naive-text-run-v1'?stage.expected_child_plan:null;
   if(p&&['run_identity','run_result','scenario','target','judge'].includes(k.kind)&&!allowed(k,p))return fail();
   return action(new PostgresTextCheckpointStore({query:(q,v)=>tx.query(q,v),transaction:fn=>fn(tx)}),tx,s,p);
  });
 }
 async function association(tx:AgentSqlExecutor,k:CheckpointLookup){return (await tx.query<Association>('SELECT * FROM workflow_stage.run_checkpoints WHERE job_id=$1 AND kind=$2 AND id=$3 FOR UPDATE',params(k))).rows[0];}
 function exact(a:Association,k:CheckpointLookup,s:WorkflowStageScope,p:Plan,token?:string){if(a.stage_key!==s.owner.stageKey||k.inputDigest!==undefined&&a.input_digest!==k.inputDigest||a.outer_id!==p.runId||a.outer_digest!==p.suiteDigest||token!==undefined&&(a.token!==token||Number(a.generation)!==s.owner.generation))return fail();}
 async function write(k:CheckpointKey,t:string,action:(inner:TextCheckpointStore)=>Promise<void>){return guarded(k,async(inner,tx,s,p)=>{if(p&&allowed(k,p)){const a=await association(tx,k);if(!a)return fail();exact(a,k,s,p,t);}return action(inner);},()=>action(store));}
 return {
  claim:k=>guarded(k,async(inner,tx,s,p)=>{
   if(!p||!allowed(k,p))return inner.claim(k);
   const before=(await tx.query<Row>('SELECT state,token,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2 AND id=$3 FOR UPDATE',params(k))).rows[0];
   const a=await association(tx,k);if(a)exact(a,k,s,p);
   if(before&&before.input_digest!==k.inputDigest)return fail();
   // An unassociated historical claim has no trusted stage lineage.
   if(before&&!a)return fail();
   let result;
   if(before?.state==='pending'&&a&&Number(a.generation)<s.owner.generation&&['run_identity','run_result','scenario','judge'].includes(k.kind)){
    if(before.token!==a.token)return fail();
    const token=randomUUID();await tx.query('UPDATE text_integration.checkpoints SET token=$4 WHERE job_id=$1 AND kind=$2 AND id=$3',[...params(k),token]);result={state:'claimed' as const,token};
   }else result=await inner.claim(k);
   if(result.state==='claimed'){
    await tx.query(`INSERT INTO workflow_stage.run_checkpoints(job_id,kind,id,input_digest,stage_key,generation,token,outer_id,outer_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(job_id,kind,id) DO UPDATE SET generation=EXCLUDED.generation,token=EXCLUDED.token`,[...params(k),k.inputDigest,s.owner.stageKey,s.owner.generation,result.token,p.runId,p.suiteDigest]);
   }
   const kind=childKind(k.kind);
   if(kind){const child={kind,operationKey:k.id,requestDigest:k.inputDigest};await registerWorkflowStageChild(tx,s.owner,child);
    if(result.state==='claimed'&&!before)await markWorkflowStageChildDispatch(tx,s.owner,child);
   }
   return result;
  },()=>store.claim(k)),
  get:k=>guarded(k,async(inner,tx,s,p)=>{if(p&&allowed(k,p)){const a=await association(tx,k);const row=(await tx.query<Row>('SELECT state,token,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2 AND id=$3',params(k))).rows[0];if(!!a!==!!row||row&&a&&(row.token!==a.token||row.input_digest!==a.input_digest))return fail();if(a)exact(a,k,s,p);}return inner.get(k);},()=>store.get(k)),
  complete:(k,t,v)=>write(k,t,inner=>inner.complete(k,t,v)),release:(k,t)=>write(k,t,inner=>inner.release(k,t)),markAmbiguous:(k,t)=>write(k,t,inner=>inner.markAmbiguous(k,t)),
 };
}
/** Read exact immutable checkpoint and attempt evidence. Behavioral target reuse does
 * not certify target monetary usage; independent reservation/outbox holds survive. */
export const workflowRunRecoveryReader:WorkflowStageRecoveryReader={async read(tx,c){
 const unknown={state:'unknown' as const,evidenceKey:`run-unverified:${c.kind}:${c.operationKey}`};
 const kind=c.kind==='text_run_target'?'target':c.kind==='text_run_judge'?'judge':null;if(!kind)return unknown;
 const k={jobId:c.jobId,kind,id:c.operationKey};
 const a=(await tx.query<Association>('SELECT * FROM workflow_stage.run_checkpoints WHERE job_id=$1 AND kind=$2 AND id=$3',params(k))).rows[0];
 const row=(await tx.query<Row>('SELECT state,token,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2 AND id=$3',params(k))).rows[0];
 const stage=(await tx.query<{generation:number;expected_child_plan:Plan}>('SELECT generation,expected_child_plan FROM workflow_stage.stages WHERE job_id=$1 AND stage_key=$2',[c.jobId,c.stageKey])).rows[0];
 if(!a||!row||!stage||stage.expected_child_plan?.profile!=='naive-text-run-v1'||!allowed(k,stage.expected_child_plan)||a.outer_id!==stage.expected_child_plan.runId||a.outer_digest!==stage.expected_child_plan.suiteDigest||Number(a.generation)>Number(stage.generation)||a.stage_key!==c.stageKey||a.input_digest!==c.requestDigest||row.input_digest!==c.requestDigest||a.token!==row.token)return unknown;
 const evidenceKey=`run-checkpoint:${kind}:${c.operationKey}:${row.token}:${workflowStageDigest(row.value??null)}`;
 const resumable={state:'resumable' as const,evidenceKey};
 if(kind==='target'){
  const response=row.value as {ok?:unknown;text?:unknown;latencyMs?:unknown;errorCode?:unknown}|null;
  const valid=response&&typeof response.latencyMs==='number'&&Number.isFinite(response.latencyMs)&&response.latencyMs>=0&&(response.ok===true&&typeof response.text==='string'||response.ok===false&&response.errorCode==='credential_in_response');
  // Completed response proves behavioral replay only. Unknown target money keeps completion held.
  return row.state==='completed'&&valid?resumable:{...unknown,evidenceKey};
 }
 if(!['pending','ready','completed'].includes(row.state))return unknown;
 const legacy=proxyBillingDigest({jobId:c.jobId,operationId:c.operationKey});
 const mode=(await tx.query<{state:string;input_digest:string;value:{mode:string}}>("SELECT state,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_proxy_mode' AND id=$2",[c.jobId,legacy])).rows[0];
 const hasAttempts=!!(await tx.query<{present:boolean}>("SELECT to_regclass('naive_proxy_dispatch.operations') IS NOT NULL AS present")).rows[0]?.present;
 const op=hasAttempts?(await tx.query<{active_attempt:number;input_digest:string;legacy_checkpoint_id:string}>('SELECT * FROM naive_proxy_dispatch.operations WHERE job_id=$1 AND operation_id=$2',[c.jobId,c.operationKey])).rows[0]:undefined;
 const legacyEvidence=(await tx.query(`SELECT 1 FROM text_integration.checkpoints WHERE job_id=$1 AND id=$2 AND kind IN ('naive_proxy_judge','naive_proxy_intent','naive_proxy_received','naive_proxy_billing') UNION ALL SELECT 1 FROM agent_persistence.reservations WHERE job_id=$1 AND id=$3 LIMIT 1`,[c.jobId,legacy,`naive-proxy:${legacy}`])).rows.length>0;
 // A fresh outer claim can resume only when no contradictory provider identity already exists.
 if(!mode)return !op&&!legacyEvidence&&row.state!=='completed'?resumable:unknown;
 if(mode.state!=='completed'||mode.input_digest!==legacy||!['v1','v2'].includes(mode.value?.mode)||Object.keys(mode.value).join(',')!=='mode')return unknown;
 let checkpointId=legacy,attemptState:string|undefined,inputDigest:string|undefined;
 if(mode.value.mode==='v2'){
  if(!hasAttempts||legacyEvidence)return unknown;
  if(!op)return row.state!=='completed'?resumable:unknown;
  if(op.legacy_checkpoint_id!==legacy||!Number.isSafeInteger(op.active_attempt)||op.active_attempt<1||!/^[a-f0-9]{64}$/.test(op.input_digest))return unknown;
  const attempt=(await tx.query<{attempt:number;checkpoint_id:string;reservation_id:string;state:string;reserved:boolean}>('SELECT * FROM naive_proxy_dispatch.attempts WHERE job_id=$1 AND operation_id=$2 AND attempt=$3',[c.jobId,c.operationKey,op.active_attempt])).rows[0];
  checkpointId=proxyBillingDigest({jobId:c.jobId,operationId:c.operationKey,attempt:op.active_attempt});
  if(!attempt||attempt.attempt!==op.active_attempt||attempt.checkpoint_id!==checkpointId||attempt.reservation_id!==`naive-proxy:${checkpointId}`||!['prepared','denied','dispatched'].includes(attempt.state)||attempt.reserved!==(attempt.state!=='denied'))return unknown;
  attemptState=attempt.state;inputDigest=op.input_digest;
 }else if(op)return unknown;
 const rows=(await tx.query<Row & {kind:string}>("SELECT kind,state,token,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND id=$2 AND kind IN ('naive_proxy_judge','naive_proxy_intent','naive_proxy_received','naive_proxy_billing')",[c.jobId,checkpointId])).rows;
 const main=rows.find(r=>r.kind==='naive_proxy_judge'),intent=rows.find(r=>r.kind==='naive_proxy_intent'),bill=rows.find(r=>r.kind==='naive_proxy_billing');
 if(new Set(rows.map(r=>r.kind)).size!==rows.length)return unknown;
 if(!inputDigest)inputDigest=main?.input_digest??intent?.input_digest;
 if(rows.length&&(!inputDigest||!/^[a-f0-9]{64}$/.test(inputDigest)||rows.some(r=>r.input_digest!==inputDigest)))return unknown;
 if(intent){
  const v=intent.value as Record<string,unknown>|null;
  if(intent.state!=='completed'||!v||v.jobId!==c.jobId||v.operationId!==c.operationKey||v.inputDigest!==inputDigest||v.schemaVersion!==`naive_proxy_intent.${mode.value.mode}`||typeof v.requestDigest!=='string'||!/^[a-f0-9]{64}$/.test(v.requestDigest)||typeof v.model!=='string'||!v.model||!Number.isSafeInteger(v.maxOutputTokens)||Number(v.maxOutputTokens)<1||Number(v.maxOutputTokens)>4096)return unknown;
  if(mode.value.mode==='v2'&&(v.attempt!==op!.active_attempt||v.checkpointId!==checkpointId||v.reservationId!==`naive-proxy:${checkpointId}`))return unknown;
 }
 // A dispatched request without its completed result cannot be recreated by takeover.
 if(attemptState==='dispatched'&&main?.state!=='completed')return unknown;
 if(mode.value.mode==='v1'&&legacyEvidence&&main?.state!=='completed')return unknown;
 if(main?.state==='completed'&&!intent)return unknown;
 if(row.state==='completed'&&main?.state!=='completed')return unknown;
 if(main?.state==='completed'&&row.state==='completed'&&bill?.state==='completed'){
  const receipt=bill.value as {idempotencyKey?:unknown;microUsd?:unknown}|null;
  if(receipt&&typeof receipt.idempotencyKey==='string'&&Number.isSafeInteger(receipt.microUsd)&&Number(receipt.microUsd)>=0){
   try{
    const reservationId=await retainedProxyReservation(tx,c.jobId,receipt.idempotencyKey);
    const reservation=(await tx.query<{settled_micro_usd:string|number|null}>('SELECT settled_micro_usd FROM agent_persistence.reservations WHERE job_id=$1 AND id=$2',[c.jobId,`naive-proxy:${checkpointId}`])).rows[0];
    if(reservationId===`naive-proxy:${checkpointId}`&&reservation?.settled_micro_usd!==null&&reservation?.settled_micro_usd!==undefined&&Number(reservation.settled_micro_usd)===receipt.microUsd)return {state:'terminal',evidenceKey:`${evidenceKey}:${checkpointId}:settled`};
   }catch{return unknown;}
  }
 }
 return {...resumable,evidenceKey:`${evidenceKey}:${mode.value.mode}:${checkpointId}:${main?.state??'absent'}`};
}};

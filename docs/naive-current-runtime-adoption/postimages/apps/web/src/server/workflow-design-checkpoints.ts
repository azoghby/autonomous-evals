import { randomUUID } from 'node:crypto';
import { PostgresTextCheckpointStore, type TextCheckpointStore, type CheckpointKey, type CheckpointLookup } from '@ae/core/evals/integration/checkpoints';
import type { AgentSqlExecutor } from '@ae/core/agents/postgres-ports';
import { assertWorkflowStageOwner } from '@ae/core/db/workflow-stage-authority';
import { currentWorkflowStageScope, type WorkflowStageScope } from './workflow-stage-runtime';

type Plan={profile:string;scope:string;outerDesignId:string;inputDigest:string};
type Association={stage_key:string;generation:number|string;token:string;input_digest:string;outer_id:string;outer_digest:string};
const fail=():never=>{throw Error('workflow_design_checkpoint_conflict');};
/** Mount only on the canonical generic design service. Stage ownership and checkpoint
 * mutations share one pinned transaction; the supplied store is used outside stages.
 * No recovery privilege is ever granted to target, judge or investigation claims. */
export function fenceWorkflowDesignCheckpoints(store:TextCheckpointStore,getScope:()=>WorkflowStageScope|undefined=currentWorkflowStageScope):TextCheckpointStore {
 async function guarded<T>(key:CheckpointLookup,run:(inner:TextCheckpointStore,tx:AgentSqlExecutor,scope:WorkflowStageScope,plan:Plan|null)=>Promise<T>,fallback:()=>Promise<T>):Promise<T>{
  const scope=getScope();if(!scope)return fallback();
  return scope.transaction(async tx=>{
   await assertWorkflowStageOwner(tx,scope.owner);
   if(key.jobId!==scope.owner.jobId)return fail();
   const stage=(await tx.query<{recovery_profile:string;expected_child_plan:Plan|null}>('SELECT recovery_profile,expected_child_plan FROM workflow_stage.stages WHERE job_id=$1 AND stage_key=$2',[key.jobId,scope.owner.stageKey])).rows[0];
   const plan=stage?.recovery_profile==='naive-design-v1'&&stage.expected_child_plan?.profile==='naive-design-v1'?stage.expected_child_plan:null;
   const inner=new PostgresTextCheckpointStore({query:(s,p)=>tx.query(s,p),transaction:fn=>fn(tx)});
   return run(inner,tx,scope,plan);
  });
 }
 function approved(key:CheckpointLookup,plan:Plan|null):plan is Plan {
  if(!plan||!['design','suite','cost'].includes(key.kind))return false;
  if(key.kind==='design'&&(key.id!==plan.outerDesignId||key.inputDigest!==plan.inputDigest))return fail();
  if(!key.inputDigest)return fail();
  return true;
 }
 const params=(k:CheckpointLookup)=>[k.jobId,k.kind,k.id];
 async function association(tx:AgentSqlExecutor,k:CheckpointLookup){return (await tx.query<Association>('SELECT * FROM workflow_stage.design_checkpoints WHERE job_id=$1 AND kind=$2 AND id=$3 FOR UPDATE',params(k))).rows[0];}
 function exact(a:Association,k:CheckpointLookup,s:WorkflowStageScope,p:Plan,token?:string){if(a.stage_key!==s.owner.stageKey||a.input_digest!==k.inputDigest||a.outer_id!==p.outerDesignId||a.outer_digest!==p.inputDigest||(token!==undefined&&(a.token!==token||Number(a.generation)!==s.owner.generation)))return fail();}
 async function write(k:CheckpointKey,token:string,action:(inner:TextCheckpointStore)=>Promise<void>){return guarded(k,async(inner,tx,scope,plan)=>{
  if(approved(k,plan)){const a=await association(tx,k);if(!a)return fail();exact(a,k,scope,plan,token);}
  return action(inner);
 },()=>action(store));}
 return {
  claim:k=>guarded(k,async(inner,tx,scope,plan)=>{
   if(!approved(k,plan))return inner.claim(k);
   const before=(await tx.query<{state:string;token:string;input_digest:string}>('SELECT state,token,input_digest FROM text_integration.checkpoints WHERE job_id=$1 AND kind=$2 AND id=$3 FOR UPDATE',params(k))).rows[0];
   const a=await association(tx,k);
   if(a)exact(a,k,scope,plan);
   if(before?.state==='pending'&&a&&Number(a.generation)<scope.owner.generation){
    if(before.token!==a.token||before.input_digest!==k.inputDigest)return fail();
    const token=randomUUID();
    await tx.query('UPDATE text_integration.checkpoints SET token=$4 WHERE job_id=$1 AND kind=$2 AND id=$3',[...params(k),token]);
    await tx.query('UPDATE workflow_stage.design_checkpoints SET generation=$4,token=$5 WHERE job_id=$1 AND kind=$2 AND id=$3',[...params(k),scope.owner.generation,token]);
    return {state:'claimed' as const,token};
   }
   // Existing unassociated pending/ambiguous rows are deliberately never adopted.
   if(!a&&(!before||before.state==='ready')){
    const count=(await tx.query<{count:string|number}>('SELECT count(*) AS count FROM workflow_stage.design_checkpoints WHERE job_id=$1 AND stage_key=$2 AND kind=$3',[k.jobId,scope.owner.stageKey,k.kind])).rows[0];
    if(Number(count?.count??0)>=(k.kind==='cost'?4:1))return fail();
   }
   const result=await inner.claim(k);
   if(result.state==='claimed'){
    if(before?.state==='pending'||before?.state==='ambiguous')return fail();
    if(a&&Number(a.generation)>scope.owner.generation)return fail();
    await tx.query(`INSERT INTO workflow_stage.design_checkpoints(job_id,kind,id,input_digest,stage_key,generation,token,outer_id,outer_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT(job_id,kind,id) DO UPDATE SET generation=EXCLUDED.generation,token=EXCLUDED.token`,[...params(k),k.inputDigest,scope.owner.stageKey,scope.owner.generation,result.token,plan.outerDesignId,plan.inputDigest]);
   }
   return result;
  },()=>store.claim(k)),
  get:k=>guarded(k,async(inner,tx,scope,plan)=>{if(approved(k,plan)){const a=await association(tx,k);if(a)exact(a,k,scope,plan);}return inner.get(k);},()=>store.get(k)),
  complete:(k,t,v)=>write(k,t,inner=>inner.complete(k,t,v)),
  release:(k,t)=>write(k,t,inner=>inner.release(k,t)),
  markAmbiguous:(k,t)=>write(k,t,inner=>inner.markAmbiguous(k,t)),
 };
}

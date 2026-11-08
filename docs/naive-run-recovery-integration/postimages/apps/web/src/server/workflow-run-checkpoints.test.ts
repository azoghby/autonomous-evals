import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import { proxyBillingDigest } from '@ae/core/judges/naive-proxy-reconcile';
import { fenceWorkflowRunCheckpoints, workflowRunRecoveryReader } from './workflow-run-checkpoints';
import type { WorkflowStageScope } from './workflow-stage-runtime';
const state=vi.hoisted(()=>({generation:1}));
vi.mock('./workflow-stage-runtime',()=>({currentWorkflowStageScope:()=>undefined,workflowStageDigest:(v:unknown)=>JSON.stringify(v)}));
// Association protocol unit tests use real SQL; full integration additionally runs
// the actual canonical job/budget/stage ownership guard.
vi.mock('@ae/core/db/workflow-stage-authority',()=>({assertWorkflowStageOwner:async(_tx:unknown,owner:{generation:number})=>{if(owner.generation!==state.generation)throw Error('stale_stage');},registerWorkflowStageChild:async()=>{},markWorkflowStageChildDispatch:async()=>{}}));
let pg:PGlite,scope:WorkflowStageScope,plain:PostgresTextCheckpointStore;
const key={jobId:'job',kind:'scenario',id:'scenario',inputDigest:'d'.repeat(64)};
const plan={profile:'naive-text-run-v1',runId:'run',suiteDigest:'a'.repeat(64),targetVersion:'v1',environment:'test',children:[{kind:'text_run_target',operationKey:'scenario'},{kind:'text_run_judge',operationKey:'judge'}]};
const sql=()=>({query:<R>(s:string,p?:unknown[])=>pg.query<R>(s,p),transaction:<T>(fn:(tx:{query:<R>(s:string,p?:unknown[])=>Promise<{rows:R[]}>})=>Promise<T>)=>pg.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))});
const wrapped=()=>fenceWorkflowRunCheckpoints(plain,()=>scope);
beforeEach(async()=>{state.generation=1;pg=new PGlite();await pg.exec(readFileSync('packages/core/src/evals/integration/migrations/001-text-integration.sql','utf8'));await pg.exec('CREATE SCHEMA workflow_stage;CREATE TABLE workflow_stage.stages(job_id text,stage_key text,recovery_profile text,expected_child_plan jsonb,generation integer DEFAULT 1)');await pg.exec('CREATE TABLE workflow_stage.run_checkpoints(job_id text,kind text,id text,input_digest text,stage_key text,generation integer,token text,outer_id text,outer_digest text,PRIMARY KEY(job_id,kind,id))');await pg.query('INSERT INTO workflow_stage.stages(job_id,stage_key,recovery_profile,expected_child_plan) VALUES($1,$2,$3,$4::jsonb)',['job','design','naive-text-run-v1',JSON.stringify(plan)]);scope={owner:{jobId:'job',stageKey:'design',token:'owner',generation:1},transaction:sql().transaction};plain=new PostgresTextCheckpointStore(sql());});
afterEach(async()=>{await pg.close();});
async function claimed(store=wrapped(),k=key){const claim=await store.claim(k);if(claim.state!=='claimed')throw Error('claim');return claim.token;}
it('recovers crash between atomic claim and completion; rotates token and fences stale owner',async()=>{const old=wrapped(),oldToken=await claimed(old);state.generation=2;const nextScope={...scope,owner:{...scope.owner,generation:2}};const next=fenceWorkflowRunCheckpoints(plain,()=>nextScope);const nextToken=await claimed(next);expect(nextToken).not.toBe(oldToken);await expect(old.complete(key,oldToken,{})).rejects.toThrow('stale_stage');await expect(next.complete(key,oldToken,{})).rejects.toThrow('checkpoint_conflict');await next.complete(key,nextToken,{done:true});expect(await next.get(key)).toEqual({state:'completed',value:{done:true}});});
it('never adopts unassociated pending or ambiguous claims',async()=>{await claimed(plain);state.generation=2;scope.owner.generation=2;await expect(wrapped().claim(key)).rejects.toThrow('checkpoint_conflict');await pg.query("UPDATE text_integration.checkpoints SET state='ambiguous'");await expect(wrapped().claim(key)).rejects.toThrow('checkpoint_conflict');});
it('holds another stage association and changed input',async()=>{await claimed();await pg.query("UPDATE workflow_stage.stages SET stage_key='other'");scope.owner.stageKey='other';await expect(wrapped().claim(key)).rejects.toThrow('checkpoint_conflict');scope.owner.stageKey='design';await pg.query("UPDATE workflow_stage.stages SET stage_key='design'");await expect(wrapped().claim({...key,inputDigest:'e'.repeat(64)})).rejects.toThrow('checkpoint_conflict');});
it('never reclaims ambiguous associated checkpoint',async()=>{const token=await claimed();await wrapped().markAmbiguous(key,token);state.generation=2;scope.owner.generation=2;expect(await wrapped().claim(key)).toEqual({state:'ambiguous'});});
it('rejects unenumerated children and never reclaims uncertain target dispatch',async()=>{await expect(wrapped().claim({...key,id:'other'})).rejects.toThrow('checkpoint_conflict');const target={...key,kind:'target'};await claimed(wrapped(),target);state.generation=2;scope.owner.generation=2;expect(await wrapped().claim(target)).toEqual({state:'pending'});});
it('reuses the exact full retained target response after takeover',async()=>{const target={...key,kind:'target'},token=await claimed(wrapped(),target);const response={ok:true,text:'exact retained full response',latencyMs:10};await wrapped().complete(target,token,response);state.generation=2;scope.owner.generation=2;expect(await wrapped().claim(target)).toEqual({state:'completed',value:response});});
it('guards every API after profile revocation and ownership loss',async()=>{const token=await claimed();await pg.query("UPDATE workflow_stage.stages SET recovery_profile='none',expected_child_plan=NULL");state.generation=2;for(const op of [()=>wrapped().claim(key),()=>wrapped().get(key),()=>wrapped().complete(key,token,{}),()=>wrapped().release(key,token),()=>wrapped().markAmbiguous(key,token)])await expect(op()).rejects.toThrow('stale_stage');expect(await plain.get(key)).toEqual({state:'pending'});});

it('never reclaims ambiguous target or independently fenced provider dispatch',async()=>{const target={...key,kind:'target'},token=await claimed(wrapped(),target);await wrapped().markAmbiguous(target,token);const provider={...key,kind:'naive_proxy_judge',id:'provider'};await claimed(wrapped(),provider);state.generation=2;scope.owner.generation=2;expect(await wrapped().claim(target)).toEqual({state:'ambiguous'});expect(await wrapped().claim(provider)).toEqual({state:'pending'});});

// Reader tests use the real immutable provider sidecar and reservation schema.
const legacy=proxyBillingDigest({jobId:'job',operationId:'judge'});
const attemptId=proxyBillingDigest({jobId:'job',operationId:'judge',attempt:1});
const providerDigest='b'.repeat(64);
async function readerSetup(){
 await pg.exec(readFileSync('packages/core/src/agents/persistence-migrations/001-agent-persistence.sql','utf8'));
 await pg.exec(readFileSync('packages/core/src/judges/migrations/001-proxy-dispatch.sql','utf8'));
 await claimed(wrapped(),{...key,kind:'judge',id:'judge'});
}
async function checkpoint(kind:string,id:string,value:unknown,inputDigest=providerDigest,state='completed'){
 await pg.query(`INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) VALUES('job',$1,$2,$3,'provider-token',$4,$5::jsonb)`,[kind,id,inputDigest,state,JSON.stringify(value)]);
}
async function mode(){await checkpoint('naive_proxy_mode',legacy,{mode:'v2'},legacy);}
async function operation(state='prepared',inputDigest=providerDigest){
 await pg.query(`INSERT INTO naive_proxy_dispatch.operations(job_id,operation_id,input_digest,policy,active_attempt,legacy_checkpoint_id) VALUES('job','judge',$1,'{}',1,$2)`,[inputDigest,legacy]);
 await pg.query(`INSERT INTO naive_proxy_dispatch.attempts(job_id,operation_id,attempt,token,checkpoint_id,reservation_id,state,reserved) VALUES('job','judge',1,'attempt-token',$1,$2,'prepared',true)`,[attemptId,`naive-proxy:${attemptId}`]);
 if(state!=='prepared')await pg.query("UPDATE naive_proxy_dispatch.attempts SET state=$1",[state]);
}
async function proof(){return workflowRunRecoveryReader.read(sql(),{jobId:'job',stageKey:'design',kind:'text_run_judge',operationKey:'judge',requestDigest:key.inputDigest,dispatchIntent:true});}
it('reader permits exact pre-mode outer pending only without provider evidence',async()=>{await readerSetup();expect((await proof()).state).toBe('resumable');});
it.each(['legacy','v2'])('reader refuses missing mode with retained %s evidence',async which=>{await readerSetup();if(which==='legacy')await checkpoint('naive_proxy_intent',legacy,{});else await operation();expect((await proof()).state).toBe('unknown');});
it('reader refuses conflicting legacy and v2 evidence',async()=>{await readerSetup();await checkpoint('naive_proxy_intent',legacy,{});await mode();await operation();expect((await proof()).state).toBe('unknown');});
it('reader holds dispatched v2 without completed provider result',async()=>{await readerSetup();await mode();await operation('dispatched');expect((await proof()).state).toBe('unknown');});
it('reader never adopts an abandoned attempt or invents its replacement',async()=>{await readerSetup();await mode();await operation('abandoned');expect((await proof()).state).toBe('unknown');expect((await pg.query('SELECT * FROM naive_proxy_dispatch.attempts')).rows).toHaveLength(1);});
it('reader refuses operation and intent digest mismatch',async()=>{await readerSetup();await mode();await operation();await checkpoint('naive_proxy_intent',attemptId,{schemaVersion:'naive_proxy_intent.v2',jobId:'job',operationId:'judge',inputDigest:'c'.repeat(64),requestDigest:'d'.repeat(64),model:'model',maxOutputTokens:20,attempt:1,checkpointId:attemptId,reservationId:`naive-proxy:${attemptId}`},'c'.repeat(64));expect((await proof()).state).toBe('unknown');});
it('reader classifies exact retained target response as behavioral resumable, never monetary terminal',async()=>{const target={...key,kind:'target'},token=await claimed(wrapped(),target);await wrapped().complete(target,token,{ok:true,text:'full original response',latencyMs:1});const result=await workflowRunRecoveryReader.read(sql(),{jobId:'job',stageKey:'design',kind:'text_run_target',operationKey:key.id,requestDigest:key.inputDigest,dispatchIntent:true});expect(result.state).toBe('resumable');});
it('refuses completed run result reads without trusted lineage',async()=>{const result={...key,kind:'run_result',id:'run'},token=await claimed(plain,result);await plain.complete(result,token,{environment:'test',run:{retained:true}});await expect(wrapped().get({jobId:'job',kind:'run_result',id:'run'})).rejects.toThrow('checkpoint_conflict');});
it('returns an associated completed run result and rejects corrupted checkpoint token',async()=>{const result={...key,kind:'run_result',id:'run'},token=await claimed(wrapped(),result),value={environment:'test',run:{retained:true}};await wrapped().complete(result,token,value);expect(await wrapped().get({jobId:'job',kind:'run_result',id:'run'})).toEqual({state:'completed',value});await pg.query("UPDATE text_integration.checkpoints SET token='corrupted' WHERE kind='run_result'");await expect(wrapped().get({jobId:'job',kind:'run_result',id:'run'})).rejects.toThrow('checkpoint_conflict');});

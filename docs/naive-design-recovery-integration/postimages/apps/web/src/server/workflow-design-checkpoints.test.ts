import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import { fenceWorkflowDesignCheckpoints } from './workflow-design-checkpoints';
import type { WorkflowStageScope } from './workflow-stage-runtime';
const state=vi.hoisted(()=>({generation:1}));
vi.mock('./workflow-stage-runtime',()=>({currentWorkflowStageScope:()=>undefined}));
// Association protocol unit tests use real SQL; full integration additionally runs
// the actual canonical job/budget/stage ownership guard.
vi.mock('@ae/core/db/workflow-stage-authority',()=>({assertWorkflowStageOwner:async(_tx:unknown,owner:{generation:number})=>{if(owner.generation!==state.generation)throw Error('stale_stage');}}));
let pg:PGlite,scope:WorkflowStageScope,plain:PostgresTextCheckpointStore;
const key={jobId:'job',kind:'design',id:'design',inputDigest:'d'.repeat(64)};
const plan={profile:'naive-design-v1',scope:'a'.repeat(24),outerDesignId:key.id,inputDigest:key.inputDigest};
const sql=()=>({query:<R>(s:string,p?:unknown[])=>pg.query<R>(s,p),transaction:<T>(fn:(tx:{query:<R>(s:string,p?:unknown[])=>Promise<{rows:R[]}>})=>Promise<T>)=>pg.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))});
const wrapped=()=>fenceWorkflowDesignCheckpoints(plain,()=>scope);
beforeEach(async()=>{state.generation=1;pg=new PGlite();await pg.exec(readFileSync('packages/core/src/evals/integration/migrations/001-text-integration.sql','utf8'));await pg.exec('CREATE SCHEMA workflow_stage;CREATE TABLE workflow_stage.stages(job_id text,stage_key text,recovery_profile text,expected_child_plan jsonb)');await pg.exec(readFileSync('docs/naive-design-recovery-integration/sql/002-design-checkpoint-ownership.sql','utf8'));await pg.query('INSERT INTO workflow_stage.stages VALUES($1,$2,$3,$4::jsonb)',['job','design','naive-design-v1',JSON.stringify(plan)]);scope={owner:{jobId:'job',stageKey:'design',token:'owner',generation:1},transaction:sql().transaction};plain=new PostgresTextCheckpointStore(sql());});
afterEach(async()=>{await pg.close();});
async function claimed(store=wrapped(),k=key){const claim=await store.claim(k);if(claim.state!=='claimed')throw Error('claim');return claim.token;}
it('recovers crash between atomic claim and completion; rotates token and fences stale owner',async()=>{const old=wrapped(),oldToken=await claimed(old);state.generation=2;const nextScope={...scope,owner:{...scope.owner,generation:2}};const next=fenceWorkflowDesignCheckpoints(plain,()=>nextScope);const nextToken=await claimed(next);expect(nextToken).not.toBe(oldToken);await expect(old.complete(key,oldToken,{})).rejects.toThrow('stale_stage');await expect(next.complete(key,oldToken,{})).rejects.toThrow('checkpoint_conflict');await next.complete(key,nextToken,{done:true});expect(await next.get(key)).toEqual({state:'completed',value:{done:true}});});
it('never adopts unassociated pending or ambiguous claims',async()=>{await claimed(plain);state.generation=2;scope.owner.generation=2;expect(await wrapped().claim(key)).toEqual({state:'pending'});await pg.query("UPDATE text_integration.checkpoints SET state='ambiguous'");expect(await wrapped().claim(key)).toEqual({state:'ambiguous'});});
it('holds another stage association and changed input',async()=>{await claimed();await pg.query("UPDATE workflow_stage.stages SET stage_key='other'");scope.owner.stageKey='other';await expect(wrapped().claim(key)).rejects.toThrow('checkpoint_conflict');scope.owner.stageKey='design';await pg.query("UPDATE workflow_stage.stages SET stage_key='design'");await expect(wrapped().claim({...key,inputDigest:'e'.repeat(64)})).rejects.toThrow('checkpoint_conflict');});
it('never reclaims ambiguous associated checkpoint',async()=>{const token=await claimed();await wrapped().markAmbiguous(key,token);state.generation=2;scope.owner.generation=2;expect(await wrapped().claim(key)).toEqual({state:'ambiguous'});});
it('bounds pure artifacts and never reclaims external dispatch',async()=>{await claimed();for(let i=0;i<4;i++)await claimed(wrapped(),{...key,kind:'cost',id:`cost${i}`});await expect(wrapped().claim({...key,kind:'cost',id:'cost4'})).rejects.toThrow('checkpoint_conflict');const target={...key,kind:'target',id:'target'};await claimed(wrapped(),target);state.generation=2;scope.owner.generation=2;expect(await wrapped().claim(target)).toEqual({state:'pending'});});
it('guards every API after profile revocation and ownership loss',async()=>{const token=await claimed();await pg.query("UPDATE workflow_stage.stages SET recovery_profile='none',expected_child_plan=NULL");state.generation=2;for(const op of [()=>wrapped().claim(key),()=>wrapped().get(key),()=>wrapped().complete(key,token,{}),()=>wrapped().release(key,token),()=>wrapped().markAmbiguous(key,token)])await expect(op()).rejects.toThrow('stale_stage');expect(await plain.get(key)).toEqual({state:'pending'});});

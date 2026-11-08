import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('@ae/core/db/client',()=>({db:()=>{throw new Error('no application DB');},schema:{}}));
import {FakeRuntime} from '@ae/core/sandbox/engine/testing/fake-runtime';
import {fakeGateway} from '@ae/core/sandbox/engine/testing/fake-gateway';
import {miniEnv,miniWorld,refundScenario} from '@ae/core/sandbox/engine/testing/fixtures';
import {PostgresTextCheckpointStore} from '@ae/core/evals/integration/checkpoints';
import type {AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
import {createMemoryStore,OWNER_A,OWNER_B} from '@/server/sandbox/memory-store.testing';
import {prepareRunWorld,runScenarioTrials,runRunInline,type PipelineDeps,type ScenarioExecutionRecord} from '@/server/sandbox/pipeline';
let sql:PGlite;let db:AgentTransactionalSql;let seq=0;
beforeAll(async()=>{sql=new PGlite();await sql.exec(readFileSync(new URL('../../../packages/core/src/evals/integration/migrations/001-text-integration.sql',import.meta.url),'utf8'));db={query:(q,p)=>sql.query(q,p),transaction:fn=>sql.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};});
afterAll(async()=>{await sql.close();});
async function setup(){
 const m=createMemoryStore(),rt=new FakeRuntime(miniWorld);const runId=`run_test_${++seq}`;let posts=0,authorized=true;
 const transport={async post(_url:string,body:unknown){posts++;const messages=(body as {messages:{role:string}[]}).messages;const seen=messages.filter(x=>x.role==='tool').length;
 const calls=[['verify_identity',{customer_id:'c_1',email:'ann@example.com'}],['lookup_order',{order_id:'o_100'}],['refund_order',{order_id:'o_100',amount:47.2}]] as const;
 if(seen<3){const [name,args]=calls[seen]!;return {choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`c${seen}`,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]};}
 return {choices:[{message:{role:'assistant',content:'Done: your refund of $47.20 for order o_100 has been issued.'},finish_reason:'stop'}]};}};
 const gw=fakeGateway(call=>call.agent==='operator'?{message:'Please refund order o_100. My customer id is c_1 and email ann@example.com.',status:'goal_achieved'}:{items:[{id:'tone',passed:true,reason:'ok'}],communicated:true,refused:false,reason:'ok',simulatorError:false,kinds:[]},{microUsdPerCall:100});
 await m.store.insertEnvironment({id:`env_${seq}`,ownerId:OWNER_A,name:'Mini',domain:'d',source:'custom',spec:miniEnv,warnings:[]});
 await m.store.insertRun({id:runId,ownerId:OWNER_A,environmentId:`env_${seq}`,status:'queued',k:1,scenarios:[refundScenario],budgetMicroUsd:3_000_000,trialsTotal:1});
 const checkpoints=new PostgresTextCheckpointStore(db);
 const deps:PipelineDeps={store:m.store,gateway:gw,runtime:()=>rt,transport:()=>transport,concurrency:1,scenarioDispatch:{checkpoints,currentSecrets:async()=>[],authorize:async input=>{
  const r=await m.store.getRun(OWNER_A,input.runId);return authorized&&!!r&&r.ownerId===input.ownerId&&r.worldId===input.worldId;
 },validateResult(raw,input){
  const value=raw as ScenarioExecutionRecord;
  if(!value||typeof value.budgetExhausted!=='boolean'||Object.keys(value).length!==2)throw new Error('invalid');
  if(value.result){if(value.result.scenarioId!==input.scenarioId||!Array.isArray(value.result.trials)||value.result.trials.some(t=>JSON.stringify(t.versions)!==JSON.stringify(input.versions)))throw new Error('invalid binding');}
  return value;
 }}};
 return {m,rt,runId,deps,checkpoints,posts:()=>posts,revoke:()=>{authorized=false;}};
}
describe('applied pipeline with actual engine and SQL dispatch checkpoints',()=>{
 it('executes once and restores publication after write failure despite later spent budget',async()=>{
  const x=await setup();const {worldId}=await prepareRunWorld(x.deps,x.runId);const put=x.m.store.putRunResult;let fail=true;
  x.m.store.putRunResult=async(...args)=>{if(fail){fail=false;throw new Error('write disconnected');}return put(...args);};
  const first=await runScenarioTrials(x.deps,x.runId,refundScenario.id,worldId);
  expect(first.status).toBe('unresolved');const posts=x.posts();expect(posts).toBeGreaterThan(0);expect(x.m.runs.get(x.runId)!.results).toEqual([]);
  await x.m.store.updateRun(x.runId,{costMicroUsd:3_000_000});
  const fresh={...x.deps,scenarioDispatch:{...x.deps.scenarioDispatch!,checkpoints:new PostgresTextCheckpointStore(db)}};
  const replay=await runScenarioTrials(fresh,x.runId,refundScenario.id,worldId);
  expect(replay).toMatchObject({status:'ok',passed:1,trials:1});expect(x.posts()).toBe(posts);expect(x.rt.runs).toHaveLength(1);expect(x.m.runs.get(x.runId)!.trialsDone).toBe(1);expect(x.m.runs.get(x.runId)!.results).toHaveLength(1);
 });
 it('keeps an active world intact on a concurrent inline retry',async()=>{
  const x=await setup();const {worldId}=await prepareRunWorld(x.deps,x.runId);const original=x.rt.startRun.bind(x.rt);let release!:()=>void;let entered!:()=>void;
  const started=new Promise<void>(r=>{entered=r});const waiting=new Promise<void>(r=>{release=r});
  x.rt.startRun=async(...args)=>{entered();await waiting;return original(...args)};
  const active=runScenarioTrials(x.deps,x.runId,refundScenario.id,worldId);await started;
  expect(await runRunInline(x.deps,x.runId)).toEqual({runId:x.runId,status:'unresolved'});
  expect(x.rt.tornDown).toEqual([]);expect(x.m.runs.get(x.runId)!.status).toBe('running');expect(x.m.runs.get(x.runId)!.worldId).toBe(worldId);
  release();expect(await active).toMatchObject({status:'ok'});
 });
 it('does not provision or dispatch with no owner port',async()=>{
  const x=await setup();const missing={...x.deps,scenarioDispatch:undefined};
  await expect(prepareRunWorld(missing,x.runId)).rejects.toThrow('scenario_dispatch_not_configured');expect(x.rt.prepared).toEqual([]);expect(x.posts()).toBe(0);
 });
 it('retains an existing world when owner wiring is absent',async()=>{
  const x=await setup();const {worldId}=await prepareRunWorld(x.deps,x.runId);
  expect(await runRunInline({...x.deps,scenarioDispatch:undefined},x.runId)).toEqual({runId:x.runId,status:'unresolved'});expect(x.rt.tornDown).toEqual([]);expect(x.m.runs.get(x.runId)!.worldId).toBe(worldId);expect(x.posts()).toBe(0);
 });
 it.each(['world','environment_owner','inventory','owner'])('refuses %s changes without duplicate effects',async change=>{
  const x=await setup();const {worldId}=await prepareRunWorld(x.deps,x.runId);expect(await runScenarioTrials(x.deps,x.runId,refundScenario.id,worldId)).toMatchObject({status:'ok'});const posts=x.posts();
  if(change==='environment_owner')x.m.envs.get(x.m.runs.get(x.runId)!.environmentId)!.ownerId=OWNER_B;
  if(change==='inventory')await x.m.store.updateRun(x.runId,{scenarios:[{...refundScenario,description:'changed'}]});
  if(change==='owner')x.m.runs.get(x.runId)!.ownerId=OWNER_B;
  expect((await runScenarioTrials(x.deps,x.runId,refundScenario.id,change==='world'?'wrong':worldId)).status).toBe('unresolved');expect(x.posts()).toBe(posts);
 });
 it('retains unresolved evidence on revocation before publication',async()=>{
  const x=await setup();const {worldId}=await prepareRunWorld(x.deps,x.runId);const complete=x.checkpoints.complete.bind(x.checkpoints);
  x.checkpoints.complete=async(...args)=>{await complete(...args);x.revoke();};
  expect((await runScenarioTrials(x.deps,x.runId,refundScenario.id,worldId)).status).toBe('unresolved');expect(x.m.runs.get(x.runId)!.results).toEqual([]);expect(x.rt.tornDown).toEqual([]);
 });
 it('success still finalizes and tears down through inline orchestration',async()=>{
  const x=await setup();expect(await runRunInline(x.deps,x.runId)).toEqual({runId:x.runId,status:'complete'});expect(x.m.runs.get(x.runId)).toMatchObject({status:'complete',trialsDone:1,worldId:null});expect(x.rt.tornDown).toHaveLength(1);
 });
});

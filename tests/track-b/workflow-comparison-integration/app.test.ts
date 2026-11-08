import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {describe,it,expect,vi} from 'vitest';
import {createRichComparisonApp,comparisonDigest} from '../apps/web/src/server/rich-comparison';
import type {AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
import {suite,artifact} from './fixture';
process.env.NAIVE_BUDGET_PERIOD_ID='offline_fixture';
const tenant='00000000-0000-0000-0000-000000000002',sub='00000000-0000-0000-0000-000000000003';
const principal={tenantId:tenant,environment:'test' as const};
const ctx={jobId:suite.jobId,environment:'test' as const,budgetMicroUsd:1000000,recordCost:vi.fn(),recordProgress:vi.fn()};
const request={operationId:'monitor:day:2026-11-07',baselineVersion:'v1',currentVersion:'v2',mode:'monitoring' as const};
async function fixture(path?:string,reopen=false){
 const db=new PGlite(path);const sql:AgentTransactionalSql={query:(s,p)=>db.query(s,p),transaction:fn=>db.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};
 if(!reopen){await db.exec(`CREATE TABLE customers(id uuid PRIMARY KEY,is_internal_fixture boolean);CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,environment text,state text,is_mock boolean,package text);
 CREATE TABLE payments(id text,job_id uuid,environment text,status text,kind text);
 CREATE TABLE monitoring_subscriptions(id uuid,job_id uuid,customer_id uuid,environment text,status text,stripe_subscription_id text);`);
 for(const p of ['packages/core/src/evals/integration/migrations/001-text-integration.sql','packages/core/src/agents/persistence-migrations/001-agent-persistence.sql','apps/web/migrations/004-rich-comparison.sql'])await db.exec(readFileSync(p,'utf8'));
 await sql.query('INSERT INTO customers VALUES($1,true)',[tenant]);await sql.query("INSERT INTO jobs VALUES($1,$2,'test','delivered',false,'text_eval')",[suite.jobId,tenant]);
 await sql.query("INSERT INTO payments VALUES('paid',$1,'test','paid','one_time')",[suite.jobId]);
 await sql.query("INSERT INTO monitoring_subscriptions VALUES($1,$2,$3,'test','active','stripe-fixture')",[sub,suite.jobId,tenant]);
 }
 const binding={suiteId:'frozen',scope:'base12',scenarioIds:suite.scenarios.map(s=>s.id),baseline:{version:'v1',targetId:'target1',branchId:null,configurationDigest:'a'.repeat(64),endpointSlot:'endpoint'},current:{version:'v2',targetId:'target2',branchId:null,configurationDigest:'b'.repeat(64),endpointSlot:'endpoint'},targetCallMicroUsd:1,jobCapMicroUsd:3000000};
 const retained=artifact('v1','original');let sourceInventory=[...binding.scenarioIds];
 const save=async()=>sql.query(`INSERT INTO workflow_comparison.bindings VALUES($1,$2::jsonb,$3::jsonb,$4::jsonb,$5) ON CONFLICT(job_id) DO UPDATE SET binding=EXCLUDED.binding,binding_digest=EXCLUDED.binding_digest`,[suite.jobId,JSON.stringify(suite),JSON.stringify(retained),JSON.stringify(binding),comparisonDigest({suite,retained,binding})]);if(!reopen)await save();
 let calls=0;const target=vi.fn(async()=>({send:async()=>{calls++;
  const tick=await sql.query<{state:string}>("SELECT state FROM text_integration.checkpoints WHERE job_id=$1 AND kind='app_rich_tick'",[suite.jobId]);expect(tick.rows[0]?.state).toBe('pending');
  return {ok:true as const,text:'READY',latencyMs:1};}}));
 const runtime={knownSecrets:[],runner:{run:vi.fn(async()=>({status:'failed' as const,taskKey:'fixture-investigation',code:'fixture_unavailable',message:'Offline investigator fixture',session:null,cost:{jobId:suite.jobId,source:'naive_session' as const,role:'quality_investigator' as const,externalId:'fixture-session',purpose:'fixture-investigation',microUsd:7,measured:true,recordedAt:'2026-11-07T00:00:00Z'}}))},verify:vi.fn(async()=>({scenarioIds:sourceInventory})),target};
 const app=createRichComparisonApp(sql,runtime);
 return {db,sql,app,runtime,binding,save,setInventory:(ids:string[])=>{sourceInventory=ids;},calls:()=>calls};
}
describe('actual app + engine + durable SQL checkpoints (offline fixtures)',()=>{
 it('claims tick before dispatch, retains rich results and replays without targets',async()=>{const f=await fixture();try{
  await f.sql.query('INSERT INTO workflow_comparison.costs VALUES($1,$2,$3,$4,$5)',[suite.jobId,comparisonDigest([tenant,suite.jobId,request.operationId,'current']),'fixture-provider','fixture-current',11]);
  const result:any=await f.app.compare(principal,ctx,request,sub);expect(f.calls()).toBe(12);expect(result.current.artifact.suite).toEqual(suite);expect(result.comparison.currentCounts.not_assessed).toBe(12);expect(result.costs.knownMicroUsd).toBe(18);expect(result.costs.unknown.length).toBeGreaterThan(0);expect(result.alertDraft).not.toBeNull();
  expect(await f.app.compare(principal,ctx,request,sub)).toEqual(result);expect(f.calls()).toBe(12);expect(f.runtime.verify.mock.calls.length).toBeGreaterThan(1);
 }finally{await f.db.close();}});
 it.each(['tenant','environment','payment','subscription','pack','hidden-pack','changed-binding'] as const)('refuses %s before dispatch/replay',async change=>{const f=await fixture();try{
  let p=principal;
  if(change==='tenant')p={...p,tenantId:sub};if(change==='environment')p={...p,environment:'live' as 'test'};
  if(change==='payment')await f.sql.query('DELETE FROM payments');if(change==='subscription')await f.sql.query("UPDATE monitoring_subscriptions SET status='canceled'");
  if(change==='pack'){f.binding.scope='augmented';f.binding.scenarioIds.push('pack-case');await f.save();expect(await f.app.inventory(principal,suite.jobId)).toMatchObject({scenarioIds:expect.arrayContaining(['pack-case'])});}
  if(change==='hidden-pack'){f.setInventory([...f.binding.scenarioIds,'app-pack']);expect(await f.app.inventory(principal,suite.jobId)).toMatchObject({scope:'augmented',scenarioIds:expect.arrayContaining(['app-pack'])});}
  if(change==='changed-binding'){await f.app.compare(p,ctx,request,sub);f.binding.current.targetId='replacement';await f.save();}
  const before=f.calls();await expect(f.app.compare(p,ctx,request,sub)).rejects.toThrow();expect(f.calls()).toBe(before);
 }finally{await f.db.close();}});
 it('requires a monitoring subscription and protects private reads',async()=>{const f=await fixture();try{
  await expect(f.app.compare(principal,ctx,request)).rejects.toThrow();await expect(f.app.read({...principal,tenantId:sub},suite.jobId,request.operationId)).rejects.toThrow();expect(f.calls()).toBe(0);
 }finally{await f.db.close();}});
 it('reopens durable app/core checkpoints without dispatch after process storage restart',async()=>{const path=mkdtempSync(join(tmpdir(),'comparison-app-restart-'));let f=await fixture(path);try{
  const result=await f.app.compare(principal,ctx,request,sub);await f.db.close();f=await fixture(path,true);
  expect(await f.app.compare(principal,ctx,request,sub)).toEqual(result);expect(f.calls()).toBe(0);
 }finally{await f.db.close();rmSync(path,{recursive:true,force:true});}});
 it('serializes duplicate dispatchers behind one durable tick claim',async()=>{const f=await fixture();try{
  const results=await Promise.allSettled([f.app.compare(principal,ctx,request,sub),f.app.compare(principal,ctx,request,sub)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(f.calls()).toBe(12);
 }finally{await f.db.close();}});
 it('fences lost workers permanently',async()=>{const f=await fixture();try{
  f.runtime.target.mockRejectedValue(new Error('lost response'));await expect(f.app.compare(principal,ctx,request,sub)).rejects.toThrow();const n=f.runtime.target.mock.calls.length;await expect(f.app.compare(principal,ctx,request,sub)).rejects.toThrow();expect(f.runtime.target.mock.calls.length).toBe(n);
 }finally{await f.db.close();}});
});

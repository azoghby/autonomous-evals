import { PGlite } from '@electric-sql/pglite';
import { afterEach,expect,it,vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AgentTransactionalSql } from '../agents/postgres-ports';
import { PostgresTextCheckpointStore } from '../evals/integration/checkpoints';
import { createNaiveProxyBudget } from '../judges/naive-proxy-budget';
import { reconcileNaiveProxyBilling,proxyBillingDigest } from '../judges/naive-proxy-reconcile';
import { naiveProxyCostEntry } from '../judges/naive-proxy-service';
import type { VettaClient } from '@usenaive-sdk/managed-agents';
import { SharedJobBudgetLedger } from './job-budget-ledger';
import { jobBudgetExposure,linkJobBudgetCost,retainedProxyReservation } from './job-budget-authority';
import { settleCost } from './cost-settlement';
const opened:PGlite[]=[];
afterEach(async()=>{for(const pg of opened.splice(0))await pg.close();});
const jobId='00000000-0000-4000-8000-000000000123',requestId='req_'+'a'.repeat(26),operationId='judge-1',model='fixture-model';
async function fixture(attempt?:number,dispatchAttempt=true){
 const pg=new PGlite();opened.push(pg);
 await pg.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,package text,customer_id uuid,environment text,budget_reserved_micro_usd bigint DEFAULT 0);
 CREATE TABLE budget_reservations(id uuid PRIMARY KEY,job_id uuid,agent text,micro_usd bigint,released_at timestamptz);
 CREATE TABLE costs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,source text,agent text,session_id text,micro_usd bigint,meta jsonb,receipt_key text,receipt_identity jsonb);
 CREATE UNIQUE INDEX cost_receipt ON costs(source,receipt_key) WHERE receipt_key IS NOT NULL;`);
 await pg.exec(readFileSync(new URL('../agents/persistence-migrations/001-agent-persistence.sql',import.meta.url),'utf8'));
 await pg.exec(readFileSync(new URL('../evals/integration/migrations/001-text-integration.sql',import.meta.url),'utf8'));
 await pg.exec(readFileSync(process.env.JOB_BUDGET_SQL??'docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql','utf8'));
 await pg.query("INSERT INTO jobs(id,package,customer_id,environment) VALUES($1,'trace_audit',$1,'test')",[jobId]);
 const db:AgentTransactionalSql={query:(s,p)=>pg.query(s,p),transaction:fn=>pg.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};
 const checkpoints=new PostgresTextCheckpointStore(db),ledger=new SharedJobBudgetLedger(db);
 const budget=createNaiveProxyBudget(ledger,{jobId,period:'2026-11',jobCapMicroUsd:3000000,judgeCapMicroUsd:3000000});
 const id=proxyBillingDigest({jobId,operationId,...(attempt===undefined?{}:{attempt})}),reservationId=`naive-proxy:${id}`,inputDigest='b'.repeat(64);
 const body={model,system:'fixture',max_output_tokens:100,messages:[{role:'user',content:'fixture'}]};
 const base={jobId,operationId,model,inputDigest,requestDigest:proxyBillingDigest(body),maxOutputTokens:100};
 const intent=attempt===undefined?{...base,schemaVersion:'naive_proxy_intent.v1'}:{...base,schemaVersion:'naive_proxy_intent.v2',attempt,checkpointId:id,reservationId};
 for(const [kind,value] of [['naive_proxy_intent',intent],['naive_proxy_received',{requestId,usage:null}]] as const){
  const key={jobId,id,inputDigest,kind};const claim=await checkpoints.claim(key);if(claim.state!=='claimed')throw Error('claim');await checkpoints.complete(key,claim.token,value);
 }
 // v2 sidecar currently reserves through its own legacy ledger. Its shared adoption
 // here is a fixture of an explicit bridge, not a claim that production mounts one.
 if(attempt!==undefined){
  await pg.exec(readFileSync(new URL('../judges/migrations/001-proxy-dispatch.sql',import.meta.url),'utf8'));
  await pg.query(`INSERT INTO naive_proxy_dispatch.operations VALUES($1,$2,$3,'{}',1,$4)`,[jobId,operationId,inputDigest,proxyBillingDigest({jobId,operationId})]);
  await pg.query("INSERT INTO naive_proxy_dispatch.attempts VALUES($1,$2,$3,'token',$4,$5,'prepared',true)",[jobId,operationId,attempt,id,reservationId]);
  if(dispatchAttempt)await pg.query("UPDATE naive_proxy_dispatch.attempts SET state='dispatched' WHERE reservation_id=$1",[reservationId]);
 }
 await budget.reserve({jobId,operationId,inputDigest,reservationId,amountMicroUsd:100,...(attempt===undefined?{}:{attempt})});
 const proxy={call:vi.fn(async()=>({id:requestId,source:'proxy',session_id:null,dialect:'anthropic',model,window:'immediate',billed_micro_usd:17,content_scope:'full',truncated:false,usage:{input:10,output:5,cache_read:0,cache_write:0},request:{model,system:body.system,max_output_tokens:100,messages:body.messages}}))} as unknown as VettaClient['proxy'];
 const recordCost=vi.fn(async(receipt:unknown)=>{await settleCost(db,{kind:'job',id:jobId},naiveProxyCostEntry(receipt,{jobId,model}));});
 const reconcile=()=>reconcileNaiveProxyBilling({jobId,operationId,...(attempt===undefined?{}:{attempt})},{checkpoints,proxy,budget,recordCost});
 const exposure=()=>db.transaction(tx=>jobBudgetExposure(tx,jobId));
 return {pg,db,reconcile,exposure,id,inputDigest,reservationId,proxy,recordCost};
}
it('real retained reconciliation and cost sink replace one settled debit, independently of a judge verdict',async()=>{
 const f=await fixture();expect((await f.exposure()).committedMicroUsd).toBe(100);
 await f.reconcile();expect((await f.exposure()).committedMicroUsd).toBe(17);
 await f.reconcile();expect((await f.exposure()).committedMicroUsd).toBe(17);
 expect(f.proxy.call).toHaveBeenCalledTimes(1);expect((await f.pg.query("SELECT * FROM text_integration.checkpoints WHERE kind='naive_proxy_judge'")).rows).toHaveLength(0);
});
it('v2 requires the exact retained dispatched attempt',async()=>{const f=await fixture(1);await f.reconcile();expect((await f.exposure()).committedMicroUsd).toBe(17);});
it('unlinked equal-amount historical public cost stays additive',async()=>{
 const f=await fixture();await f.pg.query('INSERT INTO costs(job_id,source,agent,micro_usd,meta,receipt_key) VALUES($1,$2,$3,17,$4,$5)',[jobId,'naive_proxy','judge',{operationId,measured:true},'naive_proxy:req_'+'c'.repeat(26)]);
 expect((await f.exposure()).committedMicroUsd).toBe(117);
});
for(const [label,query,params] of [
 ['received request mismatch',"UPDATE text_integration.checkpoints SET value=jsonb_set(value,'{requestId}',to_jsonb($1::text)) WHERE kind='naive_proxy_received'",['req_'+'c'.repeat(26)]],
 ['row digest mismatch',"UPDATE text_integration.checkpoints SET input_digest=$1 WHERE kind='naive_proxy_received'",['c'.repeat(64)]],
 ['intent model mismatch',"UPDATE text_integration.checkpoints SET value=jsonb_set(value,'{model}',to_jsonb($1::text)) WHERE kind='naive_proxy_intent'",['other']],
 ['settlement mismatch',"UPDATE agent_persistence.reservations SET settled_micro_usd=18",[]],
 ['reservation job mismatch',"UPDATE agent_persistence.reservations SET job_id=$1",['other-job']],
 ['cost metadata substitution',"UPDATE costs SET meta=jsonb_set(meta,'{model}',to_jsonb($1::text))",['other']],
] as const)it(`refuses ${label} without losing the retained debit`,async()=>{
 const f=await fixture();await f.reconcile();await f.pg.query(query,[...params]);
 await expect(f.reconcile()).rejects.toThrow();
});
it('conflicting billing chain rolls back first public cost insert while preserving settlement for retry',async()=>{
 const f=await fixture();
 const original=f.recordCost.getMockImplementation()!;
 f.recordCost.mockImplementation(async receipt=>{
  await f.pg.query("UPDATE text_integration.checkpoints SET input_digest='wrong' WHERE kind='naive_proxy_received'");
  await original(receipt);
 });
 await expect(f.reconcile()).rejects.toThrow();
 expect((await f.pg.query('SELECT * FROM costs')).rows).toHaveLength(0);expect((await f.exposure()).committedMicroUsd).toBe(17);
 await f.pg.query("UPDATE text_integration.checkpoints SET input_digest=$1 WHERE kind='naive_proxy_received'",[f.inputDigest]);f.recordCost.mockImplementation(original);
 await f.reconcile();expect((await f.exposure()).committedMicroUsd).toBe(17);
});
it('two retained billing chains cannot use one public request to replace two reservations',async()=>{
 const f=await fixture();await f.reconcile();
 await f.pg.query("INSERT INTO text_integration.checkpoints(job_id,kind,id,input_digest,token,state,value) SELECT job_id,kind,'duplicate',input_digest,token,state,value FROM text_integration.checkpoints WHERE kind='naive_proxy_billing'");
 await expect(f.reconcile()).rejects.toThrow();
});
it('direct linkage must independently validate the retained proxy chain',async()=>{
 const f=await fixture();await f.reconcile();const c=(await f.pg.query<{id:string}>('SELECT id FROM costs')).rows[0]!;
 await f.pg.query("UPDATE text_integration.checkpoints SET input_digest='wrong' WHERE kind='naive_proxy_received'");
 await expect(f.db.transaction(tx=>linkJobBudgetCost(tx,{jobId,operationId:`model:${f.reservationId}`,costId:c.id,expectedReceiptKey:`naive_proxy:${requestId}`}))).rejects.toThrow();
});

it('a prepared v2 attempt cannot replace the shared debit and cost insertion rolls back',async()=>{
 const f=await fixture(1,false);await expect(f.reconcile()).rejects.toThrow();
 expect((await f.pg.query('SELECT * FROM costs')).rows).toHaveLength(0);
 expect((await f.exposure()).committedMicroUsd).toBe(17);
});
for(const [field,value] of [['attempt',2],['reservationId','naive-proxy:wrong'],['checkpointId','c'.repeat(64)],['inputDigest','c'.repeat(64)]] as const)
it(`direct v2 linkage refuses mismatched ${field}`,async()=>{
 const f=await fixture(1);await f.reconcile();
 await f.pg.query("UPDATE text_integration.checkpoints SET value=jsonb_set(value,ARRAY[$1]::text[],$2::jsonb) WHERE kind='naive_proxy_intent'",[field,JSON.stringify(value)]);
 const c=(await f.pg.query<{id:string}>('SELECT id FROM costs')).rows[0]!;
 await expect(f.db.transaction(tx=>linkJobBudgetCost(tx,{jobId,operationId:`model:${f.reservationId}`,costId:c.id,expectedReceiptKey:`naive_proxy:${requestId}`}))).rejects.toThrow();
});

it('direct linkage cannot substitute a different source row using the same receipt text and amount',async()=>{
 const f=await fixture();await f.reconcile();
 const other=(await f.pg.query<{id:string}>("INSERT INTO costs(job_id,source,agent,session_id,micro_usd,meta,receipt_key,receipt_identity) SELECT job_id,'other',agent,session_id,micro_usd,meta,receipt_key,receipt_identity FROM costs RETURNING id")).rows[0]!;
 await expect(f.db.transaction(tx=>retainedProxyReservation(tx,jobId,`naive_proxy:${requestId}`,other.id))).rejects.toThrow();
 await expect(f.db.transaction(tx=>linkJobBudgetCost(tx,{jobId,operationId:`model:${f.reservationId}`,costId:other.id,expectedReceiptKey:`naive_proxy:${requestId}`}))).rejects.toThrow();
});

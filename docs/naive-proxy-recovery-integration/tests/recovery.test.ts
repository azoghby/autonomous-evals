import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterEach,describe,it,expect,vi} from 'vitest';
import type {AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
import {PostgresBudgetLedger} from '@ae/core/agents/postgres-ports';
import {PostgresTextCheckpointStore} from '@ae/core/evals/integration/checkpoints';
import {createNaiveProxyJudge} from '@ae/core/judges/naive-proxy';
import {proxyBillingDigest} from '@ae/core/judges/naive-proxy-reconcile';
import {createNaiveProxyBudget} from '@ae/core/judges/naive-proxy-budget';
import type {VettaClient} from '@usenaive-sdk/managed-agents';
const state=vi.hoisted(()=>({viewer:null as any,sql:null as any}));
vi.mock('@/server/session',()=>({getCurrentCustomer:async()=>state.viewer}));
vi.mock('@/server/automated-expert-owner',()=>({expertOwnerDatabase:()=>state.sql}));
vi.mock('@/server/cost-settlement',async()=>{const {settleCost}=await import('@ae/core/db/cost-settlement');return {recordSettledCost:(target:unknown,entry:unknown)=>settleCost(state.sql,target as any,entry)};});
import {handleProxyBillingRecovery} from '@/server/naive-proxy-recovery';
import {POST} from '@/app/api/operator/jobs/[id]/proxy-billing/reconcile/route';
const open:PGlite[]=[];afterEach(async()=>{for(const pg of open.splice(0))await pg.close();state.viewer=null;});
const jobId='00000000-0000-4000-8000-000000000123',ownerId='00000000-0000-4000-8000-000000000124';
const operator={id:'00000000-0000-4000-8000-000000000125',email:'operator@example.test',isOperator:true};
const request=(body='{}')=>new Request('https://app.invalid/api/operator/jobs/'+jobId+'/proxy-billing/reconcile',{method:'POST',body,headers:{'Content-Type':'application/json'}});
async function fixture(){
 const pg=new PGlite();open.push(pg);
 await pg.exec(readFileSync(new URL('../packages/core/src/agents/persistence-migrations/001-agent-persistence.sql',import.meta.url),'utf8'));
 await pg.exec(readFileSync(new URL('../packages/core/src/evals/integration/migrations/001-text-integration.sql',import.meta.url),'utf8'));
 await pg.exec(`CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid NOT NULL,environment text NOT NULL,package text NOT NULL,state text NOT NULL);
 CREATE TABLE costs(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,job_id uuid,source text,agent text,session_id text,micro_usd bigint,meta jsonb);`);
 await pg.exec(readFileSync(new URL('../packages/core/src/db/migrations/0023_cost_receipts.sql',import.meta.url),'utf8'));
 await pg.query('INSERT INTO jobs VALUES($1,$2,$3,$4,$5)',[jobId,ownerId,'test','text_eval','cancelled']);
 await pg.query("INSERT INTO costs(job_id,source,micro_usd,meta) VALUES($1,'ai_gateway',3000000,'{}'::jsonb)",[jobId]);
 const sql:AgentTransactionalSql={query:(q,p)=>pg.query(q,p),transaction:fn=>pg.transaction(tx=>fn({query:(q,p)=>tx.query(q,p)}))};state.sql=sql;state.viewer=operator;
 const checkpoints=new PostgresTextCheckpointStore(sql);let body:any;
 const id='req_'+'a'.repeat(26),model='test-model',text=JSON.stringify({outcome:'passed',explanation:'Reviewed',evidenceQuotes:[]});
 const messages=vi.fn(async(b:unknown)=>{body=b;return {id,model,stop_reason:'end_turn',content:[{type:'text',text}],usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0}};});
 const call=vi.fn(async()=>({id,source:'proxy',session_id:null,dialect:'anthropic',model,window:'immediate',billed_micro_usd:17,content_scope:'full',truncated:false,usage:{input:10,output:5,cache_read:0,cache_write:0},stop:'end_turn',response:{text,tool_calls:[],is_error:false,partial:false},request:{model,system:body.system,max_output_tokens:body.max_tokens,messages:body.messages}}));
 const judge=createNaiveProxyJudge({jobId,model,maxOutputTokens:1000,reservationMicroUsd:300000,checkpoints,budget:createNaiveProxyBudget(new PostgresBudgetLedger(sql),{jobId,period:'2026-11',jobCapMicroUsd:1000000,judgeCapMicroUsd:1000000}),authorize:async()=>({knownSecrets:[]}),recordCost:async()=>{throw Error('process died before app accounting');},client:()=>({proxy:{messages,call} as unknown as VettaClient['proxy']})});
 await expect(judge({operationId:'judge-1',rubric:'Be polite',response:'Customer response'})).rejects.toThrow('process died');
 const audit={call:call as unknown as VettaClient['proxy']['call']};
 const count=async()=>Number((await pg.query<{n:string}>('SELECT count(*)::text AS n FROM costs WHERE source=\'naive_proxy\'')).rows[0].n);
 return {pg,sql,messages,call,audit,count};
}
describe('operator proxy receipt recovery on actual SQL',()=>{
 it('reconciles cancelled job receipts without expert plan or inference budget and replays once',async()=>{
  const f=await fixture();const res=await handleProxyBillingRecovery(request(),jobId,{sql:f.sql,audit:f.audit});expect(res.status).toBe(200);
  expect(await res.json()).toEqual({status:'reconciled',scanned:1,reconciled:1,pending:0,remaining:false,nextCursor:null});expect(await f.count()).toBe(1);
  const row=(await f.pg.query<{receipt_identity:any}>("SELECT receipt_identity FROM costs WHERE source='naive_proxy'")).rows[0];expect(row.receipt_identity.scope).toEqual({kind:'job',id:jobId,ownerId,environment:'test'});
  await handleProxyBillingRecovery(request(),jobId,{sql:f.sql,audit:f.audit});expect(await f.count()).toBe(1);expect(f.messages).toHaveBeenCalledTimes(1);
 });
 it('advances a bounded SQL cursor past pending rows without accepting caller receipts',async()=>{
  const f=await fixture();const template=(await f.pg.query<{value:any}>("SELECT value FROM text_integration.checkpoints WHERE kind='naive_proxy_intent'")).rows[0].value;
  const store=new PostgresTextCheckpointStore(f.sql);
  for(let i=0;i<26;i++){const operationId=`pending-${i}`,value={...template,operationId};const key={jobId,kind:'naive_proxy_intent',id:proxyBillingDigest({jobId,operationId}),inputDigest:value.inputDigest};const claim=await store.claim(key);if(claim.state!=='claimed')throw Error('fixture conflict');await store.complete(key,claim.token,value);}
  const first=await (await handleProxyBillingRecovery(request(),jobId,{sql:f.sql,audit:f.audit})).json();expect(first).toMatchObject({scanned:25,remaining:true});expect(first.nextCursor).toMatch(/^[a-f0-9]{64}$/);
  const second=await (await handleProxyBillingRecovery(request(JSON.stringify({cursor:first.nextCursor})),jobId,{sql:f.sql,audit:f.audit})).json();expect(second).toMatchObject({scanned:2,remaining:false,nextCursor:null});expect(first.pending+second.pending).toBe(26);expect(await f.count()).toBe(1);expect(f.messages).toHaveBeenCalledTimes(1);
 });
 it('rejects unauthenticated/nonoperator routes and body-supplied receipts',async()=>{
  const f=await fixture();state.viewer=null;expect((await POST(request(),{params:Promise.resolve({id:jobId})})).status).toBe(401);
  state.viewer={...operator,isOperator:false};expect((await POST(request(),{params:Promise.resolve({id:jobId})})).status).toBe(403);
  state.viewer=operator;expect((await handleProxyBillingRecovery(request('{"requestId":"arbitrary"}'),jobId,{sql:f.sql,audit:f.audit})).status).toBe(400);expect(await f.count()).toBe(0);
 });
 it('checks operator again before returning accounting results',async()=>{
  const f=await fixture();const query=f.sql.query.bind(f.sql);let changed=false;
  const sql:AgentTransactionalSql={transaction:f.sql.transaction.bind(f.sql),query:async<T>(q:string,p?:unknown[])=>{const r=await query<T>(q,p);if(!changed&&q.includes("c.kind='naive_proxy_intent'")){state.viewer={...operator,isOperator:false};changed=true;}return r;}};
  const result=await handleProxyBillingRecovery(request(),jobId,{sql,audit:f.audit});expect(result.status).toBe(403);expect(await f.count()).toBe(0);expect(f.messages).toHaveBeenCalledTimes(1);
 });
 it('bounds streamed request bytes before JSON allocation and makes every response private',async()=>{
  const f=await fixture();let cancelled=false;
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(257));},cancel(){cancelled=true;}});
  const req=new Request('https://app.invalid/recovery',{method:'POST',body:stream,headers:{'Content-Type':'application/json'},duplex:'half'} as RequestInit);
  const res=await handleProxyBillingRecovery(req,jobId,{sql:f.sql,audit:f.audit});expect(res.status).toBe(413);expect(cancelled).toBe(true);expect(await f.count()).toBe(0);
  expect(res.headers.get('cache-control')).toContain('private, no-store');expect(res.headers.get('vary')).toBe('Cookie');
  state.viewer=null;const denied=await POST(request(),{params:Promise.resolve({id:jobId})});expect(denied.headers.get('cache-control')).toContain('private, no-store');expect(denied.headers.get('vary')).toBe('Cookie');
  state.viewer=operator;state.sql=null;const unavailable=await handleProxyBillingRecovery(request(),jobId,{audit:f.audit});expect(unavailable.status).toBe(503);expect(unavailable.headers.get('cache-control')).toContain('private, no-store');
 });
 it('settles an in-flight audited debit but starts no next audit after operator revocation',async()=>{
  const f=await fixture();
  const records=(await f.pg.query<{id:string;kind:string;value:any}>("SELECT id,kind,value FROM text_integration.checkpoints WHERE kind IN ('naive_proxy_intent','naive_proxy_received')")).rows;
  const intent=records.find(r=>r.kind==='naive_proxy_intent')!,received=records.find(r=>r.kind==='naive_proxy_received')!;
  let operationId='';for(let i=0;i<10000;i++){const candidate=`later-${i}`;if(proxyBillingDigest({jobId,operationId:candidate})>intent.id){operationId=candidate;break;}}if(!operationId)throw Error('fixture ordering');
  const store=new PostgresTextCheckpointStore(f.sql);const id=proxyBillingDigest({jobId,operationId});
  for(const [kind,value] of [['naive_proxy_intent',{...intent.value,operationId}],['naive_proxy_received',{...received.value,requestId:'req_'+'b'.repeat(26)}]] as const){const key={jobId,kind,id,inputDigest:intent.value.inputDigest};const claim=await store.claim(key);if(claim.state!=='claimed')throw Error('fixture conflict');await store.complete(key,claim.token,value);}
  await f.pg.query("DELETE FROM text_integration.checkpoints WHERE kind='naive_proxy_billing'");
  const trace=f.call.getMockImplementation()!;f.call.mockClear();f.call.mockImplementationOnce(async()=>{const result=await trace();state.viewer={...operator,isOperator:false};return result;});
  const res=await handleProxyBillingRecovery(request(),jobId,{sql:f.sql,audit:f.audit});expect(res.status).toBe(403);expect(await f.count()).toBe(1);expect(f.call).toHaveBeenCalledTimes(1);expect(f.messages).toHaveBeenCalledTimes(1);
 });
 it('fails closed when canonical owner/environment changes before sink commit',async()=>{
  const f=await fixture();const query=f.sql.query.bind(f.sql);let changed=false;
  const sql:AgentTransactionalSql={transaction:f.sql.transaction.bind(f.sql),query:async<T>(q:string,p?:unknown[])=>{const r=await query<T>(q,p);if(!changed&&q.includes("c.kind='naive_proxy_intent'")){await f.pg.query("UPDATE jobs SET environment='live' WHERE id=$1",[jobId]);changed=true;}return r;}};
  const result=await handleProxyBillingRecovery(request(),jobId,{sql,audit:f.audit});expect(await result.json()).toMatchObject({status:'requires_reconciliation',pending:1});expect(await f.count()).toBe(0);
 });
});

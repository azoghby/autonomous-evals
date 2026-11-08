import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach,describe,it,expect,vi } from 'vitest';
import { PostgresTextCheckpointStore } from '../evals/integration/checkpoints';
import { PostgresBudgetLedger,type AgentTransactionalSql,type AgentSqlExecutor } from '../agents/postgres-ports';
import type { VettaClient } from '@usenaive-sdk/managed-agents';
import { createNaiveProxyJudge,type NaiveProxyCost } from './naive-proxy';
import { reconcileNaiveProxyBilling } from './naive-proxy-reconcile';
import { createNaiveProxyBudget } from './naive-proxy-budget';
import { naiveProxyCostEntry } from './naive-proxy-service';

const opened:PGlite[]=[];
afterEach(async()=>{for(const pg of opened.splice(0))await pg.close();});
/** Actual PostgreSQL execution in PGlite; single connection, not a concurrency test. */
async function fixture(){
 const pg=new PGlite();opened.push(pg);let failMain=false;
 await pg.exec(readFileSync(new URL('../evals/integration/migrations/001-text-integration.sql',import.meta.url),'utf8'));
 await pg.exec(readFileSync(new URL('../agents/persistence-migrations/001-agent-persistence.sql',import.meta.url),'utf8'));
 await pg.exec('CREATE TABLE fixture_cost(receipt_key text PRIMARY KEY, receipt jsonb NOT NULL)');
 const forward=(executor:AgentSqlExecutor):AgentSqlExecutor=>({query:async <T>(text:string,p:unknown[]=[])=>{
  const result=await executor.query<T>(text,p);
  // Write reached PostgreSQL inside complete()'s transaction. Throwing must roll it back.
  if(failMain&&text.includes("SET state = 'completed'")&&p[1]==='naive_proxy_judge'){
   failMain=false;throw Error('worker crashed after SQL write');
  }
  return result;
 }});
 const db:AgentTransactionalSql={query:forward(pg).query,transaction:fn=>pg.transaction(tx=>fn(forward(tx)))};
 const checkpoints=new PostgresTextCheckpointStore(db);
 const jobId='00000000-0000-4000-8000-000000000123',operationId='judge-1',model='test-model';
 const input={operationId,rubric:'Be polite',response:'Please continue'};
 const id='req_'+'a'.repeat(26),text=JSON.stringify({outcome:'rubric_concern',explanation:'Tone concern',evidenceQuotes:['Please']});
 let body:any;
 const messages=vi.fn(async(b:unknown)=>{body=b;return {id,model,stop_reason:'end_turn',content:[{type:'text',text}],usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0}};});
 const call=vi.fn(async()=>({id,source:'proxy',session_id:null,dialect:'anthropic',model,window:'immediate',billed_micro_usd:17,content_scope:'full',truncated:false,usage:{input:10,output:5,cache_read:0,cache_write:0},stop:'end_turn',response:{text,tool_calls:[],is_error:false,partial:false},request:{model,system:body.system,max_output_tokens:body.max_tokens,messages:body.messages}}));
 const budget=createNaiveProxyBudget(new PostgresBudgetLedger(db),{jobId,period:'2026-11',jobCapMicroUsd:1000000,judgeCapMicroUsd:1000000});
 const recordCost=vi.fn(async(receipt:NaiveProxyCost)=>{
  const entry=naiveProxyCostEntry(receipt,{jobId,model});
  await db.transaction(async tx=>{
   await tx.query('INSERT INTO fixture_cost VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',[receipt.idempotencyKey,JSON.stringify(entry)]);
   const row=await tx.query<{equal:boolean}>('SELECT receipt=$2::jsonb AS equal FROM fixture_cost WHERE receipt_key=$1',[receipt.idempotencyKey,JSON.stringify(entry)]);
   if(!row.rows[0]?.equal)throw Error('cost conflict');
  });
 });
 const costCount=async()=>Number((await pg.query<{count:string}>('SELECT count(*)::text AS count FROM fixture_cost')).rows[0].count);
 const settledCount=async()=>Number((await pg.query<{count:string}>('SELECT count(*)::text AS count FROM agent_persistence.reservations WHERE settled_micro_usd IS NOT NULL')).rows[0].count);
 const metadata=async()=> (await pg.query("SELECT kind,value FROM text_integration.checkpoints WHERE kind IN ('naive_proxy_intent','naive_proxy_received')")).rows;
 const checkpointStates=async()=> (await pg.query<{kind:string;state:string}>('SELECT kind,state FROM text_integration.checkpoints')).rows;
 const authorize=vi.fn(async()=>({knownSecrets:[]}));
 const proxy={messages,call} as unknown as VettaClient['proxy'];
 const judge=createNaiveProxyJudge({jobId,model,maxOutputTokens:1000,reservationMicroUsd:300000,client:()=>({proxy}),checkpoints,budget,recordCost,authorize});
 const reconcile=()=>reconcileNaiveProxyBilling({jobId,operationId},{checkpoints:new PostgresTextCheckpointStore(db),proxy,budget:createNaiveProxyBudget(new PostgresBudgetLedger(db),{jobId,period:'2026-11',jobCapMicroUsd:1000000,judgeCapMicroUsd:1000000}),recordCost});
 const rewriteMetadata=async(kind:string,value:unknown)=>{await pg.query('UPDATE text_integration.checkpoints SET value=$2::jsonb WHERE kind=$1',[kind,JSON.stringify(value)]);};
 return {judge,reconcile,input,metadata,rewriteMetadata,checkpointStates,messages,call,recordCost,costCount,settledCount,authorize,crash:()=>{failMain=true;}};
}
describe('independent Jude billing recovery',()=>{
 it('recovers a crash after request identity retention despite revoked evaluation authority',async()=>{
  const f=await fixture();f.crash();await expect(f.judge(f.input)).rejects.toThrow('unavailable');
  f.authorize.mockRejectedValue(Error('revoked'));const authorizationCalls=f.authorize.mock.calls.length;const receipt=await f.reconcile();
  expect(f.authorize).toHaveBeenCalledTimes(authorizationCalls);
  expect(receipt.microUsd).toBe(17);expect(await f.costCount()).toBe(1);expect(await f.settledCount()).toBe(1);expect(f.messages).toHaveBeenCalledTimes(1);
  const metadata=await f.metadata();
  expect(await f.checkpointStates()).toContainEqual({kind:'naive_proxy_judge',state:'ambiguous'});
  expect(JSON.stringify(metadata)).not.toContain('Be polite');expect(JSON.stringify(metadata)).not.toContain('Please continue');expect(JSON.stringify(metadata)).not.toContain('Tone concern');
  await expect(f.judge(f.input)).rejects.toThrow('revoked');expect(f.messages).toHaveBeenCalledTimes(1);
 });
 it('holds delayed billing then replays the exact receipt after lost cost acknowledgement',async()=>{
  const f=await fixture();f.crash();await expect(f.judge(f.input)).rejects.toThrow();const trace=f.call.getMockImplementation()!;
  f.call.mockImplementationOnce(async()=>({...await trace(),billed_micro_usd:null}) as never);
  await expect(f.reconcile()).rejects.toThrow('unavailable');expect(await f.costCount()).toBe(0);
  const sink=f.recordCost.getMockImplementation()!;f.recordCost.mockImplementationOnce(async receipt=>{await sink(receipt);throw Error('ack lost');});
  await expect(f.reconcile()).rejects.toThrow('ack lost');const receipt=await f.reconcile();expect(receipt.microUsd).toBe(17);expect(await f.costCount()).toBe(1);expect(f.messages).toHaveBeenCalledTimes(1);expect(f.call).toHaveBeenCalledTimes(2);
 });
 it('strictly rejects extra prompt-bearing fields in retained recovery metadata',async()=>{
  const f=await fixture();f.crash();await expect(f.judge(f.input)).rejects.toThrow();
  const metadata=await f.metadata() as Array<{kind:string;value:Record<string,unknown>}>;
  const intent=metadata.find(r=>r.kind==='naive_proxy_intent')!.value;
  expect(Object.keys(intent).sort()).toEqual(['inputDigest','jobId','maxOutputTokens','model','operationId','requestDigest','schemaVersion'].sort());
  await f.rewriteMetadata('naive_proxy_intent',{...intent,prompt:'untrusted prompt'});
  await expect(f.reconcile()).rejects.toThrow('unavailable');expect(f.call).not.toHaveBeenCalled();
  await f.rewriteMetadata('naive_proxy_intent',intent);
  const received=metadata.find(r=>r.kind==='naive_proxy_received')!.value;
  expect(Object.keys(received).sort()).toEqual(['requestId','usage']);
  await f.rewriteMetadata('naive_proxy_received',{...received,text:'untrusted response'});
  await expect(f.reconcile()).rejects.toThrow('unavailable');expect(f.call).not.toHaveBeenCalled();expect(await f.costCount()).toBe(0);
 });
 it('keeps ambiguous dispatch without a request identity fenced',async()=>{
  const f=await fixture();f.messages.mockRejectedValueOnce(Error('timeout'));await expect(f.judge(f.input)).rejects.toThrow();
  await expect(f.reconcile()).rejects.toThrow('unavailable');expect(f.call).not.toHaveBeenCalled();expect(await f.costCount()).toBe(0);expect(f.messages).toHaveBeenCalledTimes(1);
 });
 it('rejects provider trace with a changed request body or unrelated session',async()=>{
  const f=await fixture();f.crash();await expect(f.judge(f.input)).rejects.toThrow();const trace=f.call.getMockImplementation()!;
  f.call.mockImplementationOnce((async()=>{const t=await trace();return {...t,request:{...t.request,messages:[{role:'user',content:'changed'}]}};}) as never);
  await expect(f.reconcile()).rejects.toThrow('unavailable');expect(await f.costCount()).toBe(0);
  f.call.mockImplementationOnce(async()=>({...await trace(),session_id:'ses_other'}) as never);
  await expect(f.reconcile()).rejects.toThrow('unavailable');expect(await f.settledCount()).toBe(0);
 });
});

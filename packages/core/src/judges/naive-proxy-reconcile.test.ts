import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach,describe,it,expect,vi } from 'vitest';
import { PostgresTextCheckpointStore } from '../evals/integration/checkpoints';
import { PostgresBudgetLedger,type AgentTransactionalSql,type AgentSqlExecutor } from '../agents/postgres-ports';
import type { VettaClient } from '@usenaive-sdk/managed-agents';
import { createNaiveProxyJudge,NaiveProxyJudgePendingError,type NaiveProxyCost } from './naive-proxy';
import { PostgresNaiveProxyDispatchStore } from './naive-proxy-dispatch-store';
import { reconcileNaiveProxyBilling } from './naive-proxy-reconcile';
import { createNaiveProxyBudget } from './naive-proxy-budget';
import { naiveProxyCostEntry } from './naive-proxy-service';

const opened:PGlite[]=[];
afterEach(async()=>{for(const pg of opened.splice(0))await pg.close();});
/** Actual PostgreSQL execution in PGlite; single connection, not a concurrency test. */
async function fixture(attemptMode=false){
 const pg=new PGlite();opened.push(pg);let failMain=false;
 await pg.exec(readFileSync(new URL('../evals/integration/migrations/001-text-integration.sql',import.meta.url),'utf8'));
 await pg.exec(readFileSync(new URL('../agents/persistence-migrations/001-agent-persistence.sql',import.meta.url),'utf8'));
 if(attemptMode)await pg.exec(readFileSync(new URL('./migrations/001-proxy-dispatch.sql',import.meta.url),'utf8'));
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
 const dispatch=attemptMode?new PostgresNaiveProxyDispatchStore(db,{jobId,period:'2026-11',jobCapMicroUsd:1000000,judgeCapMicroUsd:1000000}):undefined;
 const makeJudge=()=>createNaiveProxyJudge({jobId,model,maxOutputTokens:1000,reservationMicroUsd:300000,client:()=>({proxy}),checkpoints:new PostgresTextCheckpointStore(db),budget,recordCost,authorize,...(dispatch?{dispatch}:{})});
 const judge=makeJudge();
 const reconcile=(attempt=attemptMode?1:undefined)=>reconcileNaiveProxyBilling({jobId,operationId,...(attempt===undefined?{}:{attempt})},{checkpoints:new PostgresTextCheckpointStore(db),proxy,budget:createNaiveProxyBudget(new PostgresBudgetLedger(db),{jobId,period:'2026-11',jobCapMicroUsd:1000000,judgeCapMicroUsd:1000000}),recordCost});
 const rewriteMetadata=async(kind:string,value:unknown)=>{await pg.query('UPDATE text_integration.checkpoints SET value=$2::jsonb WHERE kind=$1',[kind,JSON.stringify(value)]);};
 return {judge,makeJudge,reconcile,input,metadata,rewriteMetadata,checkpointStates,messages,call,recordCost,costCount,settledCount,authorize,dispatch,pg,db,jobId,operationId,crash:()=>{failMain=true;}};
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
describe('SQL attempt-backed Jude dispatch and billing',()=>{
 const owner=async()=>({actorId:'operator:test',reason:'Explicitly recover proven undispatched attempt'});
 async function attemptIdentity(f:Awaited<ReturnType<typeof fixture>>,attempt=1){
  const row=(await f.pg.query<{input_digest:string}>('SELECT input_digest FROM naive_proxy_dispatch.operations WHERE job_id=$1 AND operation_id=$2',[f.jobId,f.operationId])).rows[0];
  return {jobId:f.jobId,operationId:f.operationId,inputDigest:row.input_digest,attempt};
 }
 it('keeps denied attempts pending until explicit recovery and settles only the new attempt',async()=>{
  const f=await fixture(true),ledger=new PostgresBudgetLedger(f.db);
  await ledger.reserve({reservationId:'blocker',jobId:f.jobId,amountMicroUsd:800000,scopes:[{key:`job:${f.jobId}`,capMicroUsd:1000000},{key:'agent:judge:2026-11',capMicroUsd:1000000}]});
  await expect(f.judge(f.input)).rejects.toMatchObject({code:'naive_proxy_judge_pending',reason:'budget_denied',attempt:1});
  await ledger.settle('blocker',0);
  await expect(f.makeJudge()(f.input)).rejects.toBeInstanceOf(NaiveProxyJudgePendingError);
  expect(f.messages).not.toHaveBeenCalled();
  await f.dispatch!.recoverUndispatched(await attemptIdentity(f),owner);
  expect((await f.makeJudge()(f.input)).outcome).toBe('rubric_concern');
  const rows=(await f.pg.query<{attempt:number;state:string;settled_micro_usd:number|null}>(`SELECT a.attempt,a.state,r.settled_micro_usd FROM naive_proxy_dispatch.attempts a JOIN agent_persistence.reservations r ON r.id=a.reservation_id ORDER BY a.attempt`)).rows;
  expect(rows.map(r=>({attempt:r.attempt,state:r.state,settled:r.settled_micro_usd===null?null:Number(r.settled_micro_usd)}))).toEqual([{attempt:1,state:'abandoned',settled:null},{attempt:2,state:'dispatched',settled:17}]);
  expect(f.messages).toHaveBeenCalledTimes(1);expect((await f.reconcile(2)).microUsd).toBe(17);
 });
 it('releases a revoked undispatched hold without reusing its zero settlement',async()=>{
  const f=await fixture(true);f.authorize.mockResolvedValueOnce({knownSecrets:[]}).mockRejectedValueOnce(Error('revoked'));
  await expect(f.judge(f.input)).rejects.toBeInstanceOf(NaiveProxyJudgePendingError);expect(f.messages).not.toHaveBeenCalled();
  await f.dispatch!.recoverUndispatched(await attemptIdentity(f),owner);
  expect((await f.makeJudge()(f.input)).outcome).toBe('rubric_concern');
  const settlements=(await f.pg.query<{n:string}>('SELECT settled_micro_usd::text AS n FROM agent_persistence.reservations ORDER BY id')).rows.map(r=>r.n).sort();
  expect(settlements).toEqual(['0','17']);
  await expect(f.dispatch!.recoverUndispatched(await attemptIdentity(f,2),owner)).rejects.toThrow('unavailable');
 });
 it('fences a lost dispatch acknowledgement and never misclassifies it as undispatched pending',async()=>{
  const f=await fixture(true),dispatch=f.dispatch!.dispatch.bind(f.dispatch!);
  vi.spyOn(f.dispatch!,'dispatch').mockImplementationOnce(async handle=>{await dispatch(handle);throw Error('dispatch acknowledgement lost');});
  await expect(f.judge(f.input)).rejects.toMatchObject({code:'naive_proxy_judge_reconciliation_required'});
  await expect(f.makeJudge()(f.input)).rejects.not.toBeInstanceOf(NaiveProxyJudgePendingError);
  expect(f.messages).not.toHaveBeenCalled();await expect(f.dispatch!.recoverUndispatched(await attemptIdentity(f),owner)).rejects.toThrow('unavailable');
 });
 it('keeps a stale abandoned worker pending after the replacement attempt dispatches',async()=>{
  const f=await fixture(true);f.authorize.mockResolvedValueOnce({knownSecrets:[]}).mockRejectedValueOnce(Error('revoked'));
  await expect(f.judge(f.input)).rejects.toBeInstanceOf(NaiveProxyJudgePendingError);
  const identity=await attemptIdentity(f),old=await f.dispatch!.prepare({...identity,amountMicroUsd:300000});
  await f.dispatch!.recoverUndispatched(identity,owner);
  expect((await f.makeJudge()(f.input)).outcome).toBe('rubric_concern');
  vi.spyOn(f.dispatch!,'prepare').mockResolvedValueOnce(old);
  await expect(f.makeJudge()(f.input)).rejects.toMatchObject({code:'naive_proxy_judge_pending',attempt:1});
  await expect(f.dispatch!.dispatch(old)).rejects.toThrow('unavailable');expect(f.messages).toHaveBeenCalledTimes(1);
 });
 it('holds a proven undispatched attempt when checkpoint setup fails after reservation',async()=>{
  const f=await fixture(true);
  const read=vi.spyOn(PostgresTextCheckpointStore.prototype,'get').mockRejectedValueOnce(Error('checkpoint read acknowledgement lost'));
  try{await expect(f.judge(f.input)).rejects.toMatchObject({code:'naive_proxy_judge_pending',attempt:1});}finally{read.mockRestore();}
  expect(f.messages).not.toHaveBeenCalled();await f.dispatch!.recoverUndispatched(await attemptIdentity(f),owner);
  expect((await f.makeJudge()(f.input)).outcome).toBe('rubric_concern');expect(f.messages).toHaveBeenCalledTimes(1);
 });
 it('reads a lost prepare acknowledgement without another reservation or paid dispatch',async()=>{
  const f=await fixture(true),prepare=f.dispatch!.prepare.bind(f.dispatch!);
  vi.spyOn(f.dispatch!,'prepare').mockImplementationOnce(async input=>{await prepare(input);throw Error('prepare acknowledgement lost');});
  await expect(f.judge(f.input)).rejects.toMatchObject({code:'naive_proxy_judge_pending',attempt:1});
  expect(f.messages).not.toHaveBeenCalled();expect(await f.settledCount()).toBe(0);
  expect((await f.pg.query('SELECT 1 FROM agent_persistence.reservations')).rows).toHaveLength(1);
  const retained=await attemptIdentity(f);
  await expect(f.dispatch!.lookup({...retained,amountMicroUsd:1})).rejects.toThrow('unavailable');
  await expect(f.dispatch!.lookup({...retained,inputDigest:'b'.repeat(64),amountMicroUsd:300000})).rejects.toThrow('unavailable');
  await f.dispatch!.recoverUndispatched(await attemptIdentity(f),owner);
  expect((await f.makeJudge()(f.input)).outcome).toBe('rubric_concern');expect(f.messages).toHaveBeenCalledTimes(1);
 });
 it.each(['missing','failed'] as const)('holds unknown prepare outcomes when lookup is %s',async mode=>{
  const f=await fixture(true);
  vi.spyOn(f.dispatch!,'prepare').mockRejectedValueOnce(Error('prepare outcome unknown'));
  if(mode==='failed')vi.spyOn(f.dispatch!,'lookup').mockRejectedValueOnce(Error('lookup unavailable'));
  await expect(f.judge(f.input)).rejects.toMatchObject({code:'naive_proxy_judge_reconciliation_required'});
  expect(f.messages).not.toHaveBeenCalled();expect(await f.costCount()).toBe(0);
  expect((await f.pg.query('SELECT 1 FROM naive_proxy_dispatch.operations')).rows).toHaveLength(0);
 });
 it('independently reconciles v2 after crash and revocation while rejecting v1/v2 or attempt identity mismatch',async()=>{
  const f=await fixture(true);f.crash();await expect(f.judge(f.input)).rejects.toThrow();f.authorize.mockRejectedValue(Error('revoked'));
  const calls=f.authorize.mock.calls.length;expect((await f.reconcile()).microUsd).toBe(17);expect(f.authorize).toHaveBeenCalledTimes(calls);expect(f.messages).toHaveBeenCalledTimes(1);
  await expect(f.reconcile(2)).rejects.toThrow('unavailable');
  const metadata=await f.metadata() as Array<{kind:string;value:Record<string,unknown>}>;const intent=metadata.find(r=>r.kind==='naive_proxy_intent')!.value;
  expect(intent).toMatchObject({schemaVersion:'naive_proxy_intent.v2',attempt:1});
  await f.rewriteMetadata('naive_proxy_intent',{...intent,attempt:2});await expect(f.reconcile()).rejects.toThrow('unavailable');
  const {attempt:_attempt,checkpointId:_checkpoint,reservationId:_reservation,...v1}=intent;
  await f.rewriteMetadata('naive_proxy_intent',{...v1,schemaVersion:'naive_proxy_intent.v1'});await expect(f.reconcile()).rejects.toThrow('unavailable');
 });
});

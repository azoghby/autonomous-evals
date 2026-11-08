/** Real SQL/stage/attempt/accounting composition; provider and keyed cost transport are offline fixtures. */
import {PGlite} from '@electric-sql/pglite';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {VettaClient} from '@usenaive-sdk/managed-agents';
import type {AgentTransactionalSql,AgentSqlExecutor} from '@ae/core/agents/postgres-ports';
import type {ServiceContext} from '@ae/core/contracts/services';
import {PostgresTextCheckpointStore} from '@ae/core/evals/integration/checkpoints';
import {createNaiveProxyBudget} from '@ae/core/judges/naive-proxy-budget';
import {SharedJobBudgetLedger} from '@ae/core/db/job-budget-ledger';
import {jobBudgetExposure} from '@ae/core/db/job-budget-authority';
import {createAttemptAwareJudge,selectJudgeAttemptMode,drainRuntimeJudgeAccounting} from './judge-attempt-runtime';
import {drainJudgeAccounting,handleJudgeOwnerRecovery,type JudgeOwnerRecoveryDeps} from './judge-owner-recovery';
import {trustedJudgeAccountingDependencies} from './judge-owner-recovery-production';
import {createWorkflowStageBudgetLedger} from './workflow-stage-budget';
import {executeWorkflowStage} from './workflow-stage-runtime';
vi.mock('server-only',()=>({}));
const state=vi.hoisted(()=>({pg:undefined as PGlite|undefined,stepId:'first',attempt:0}));
vi.mock('workflow',()=>({getStepMetadata:()=>({stepId:state.stepId,attempt:state.attempt}),getWorkflowMetadata:()=>({workflowRunId:'fixture-run'}),FatalError:class extends Error{},RetryableError:class extends Error{}}));
vi.mock('@neondatabase/serverless',()=>({Pool:class{async connect(){return {query:(sql:string,params?:unknown[])=>state.pg!.query(sql,params),release(){}};}}}));
let pg:PGlite;let sql:AgentTransactionalSql;
const job='a1b2c3d4-e5f6-47a8-9b0c-d1e2f3a4b5c6',customer='b1c2d3e4-f5a6-47b8-9c0d-e1f2a3b4c5d6';
const taskKey=`${job}:quality_investigator:resume_fixture:1`;
const input={jobId:job,ownerId:customer,environment:'test' as const,role:'investigator',share:.9,stage:{key:'strict-single-fixture',input:{revision:1},recovery:'naive-single-child-v1' as const,expectedChildKey:taskKey,isPending:(value:unknown)=>(value as {status:string}).status==='pending'}};
const migrations=[
 'packages/core/src/agents/persistence-migrations/001-agent-persistence.sql',
 'packages/core/src/evals/remediation/accounting/001-remediation-accounting.sql',
 'docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql',
 'docs/naive-stage-ownership-integration/sql/001-workflow-stage-ownership.sql',
 'docs/naive-stage-recovery-integration/sql/001-stage-recovery-profile.sql',
 'docs/naive-cancellation-integration/sql/001-job-cancellation.sql',
 'packages/core/src/evals/integration/migrations/001-text-integration.sql',
 'docs/naive-design-recovery-integration/sql/001-design-stage-recovery.sql',
 'docs/naive-design-recovery-integration/sql/002-design-checkpoint-ownership.sql',
 'docs/naive-budget-envelope-integration/sql/001-stage-model-envelopes.sql',
 'packages/core/src/judges/migrations/001-proxy-dispatch.sql',
];
beforeEach(async()=>{
 process.env.DATABASE_URL='postgres://offline-fixture';process.env.CREDENTIALS_ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');
 pg=new PGlite();state.pg=pg;state.stepId='first';state.attempt=0;
 await pg.exec(`CREATE TABLE customers(id uuid PRIMARY KEY,email text);CREATE TABLE jobs(id uuid PRIMARY KEY,package text,customer_id uuid,environment text,state text NOT NULL DEFAULT 'running',budget_reserved_micro_usd bigint DEFAULT 0);
 CREATE TABLE budget_reservations(id uuid PRIMARY KEY,job_id uuid,agent text,micro_usd bigint,released_at timestamptz);
 CREATE TABLE costs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),job_id uuid,micro_usd bigint,receipt_key text,source text,agent text,session_id text,meta jsonb,receipt_identity jsonb); CREATE UNIQUE INDEX costs_receipt ON costs(source,receipt_key) WHERE receipt_key IS NOT NULL;`);
 for(const path of migrations)await pg.exec(readFileSync(resolve(path),'utf8'));
 await pg.query('INSERT INTO jobs(id,package,customer_id,environment) VALUES($1,$2,$3,$4)',[job,'trace_audit',customer,'test']);
 sql={query:(text,args)=>pg.query(text,args),transaction:fn=>pg.transaction(tx=>fn({query:(text,args)=>tx.query(text,args)}))};
});
afterEach(async()=>{await pg.close();vi.unstubAllEnvs();});

function fixture(){
 vi.stubEnv('NAIVE_JUDGE_ATTEMPTS','1');
 const config={jobId:job,period:'2026-11',jobCapMicroUsd:3_000_000,judgeCapMicroUsd:60_000_000,additionalScopes:[{key:`generic-text:${job}`,capMicroUsd:300_000}]};
 const request={operationId:'judge:retained-response',rubric:'Be polite',response:'Please continue'};
 const id='req_'+'a'.repeat(26),model='fixture-model',text=JSON.stringify({outcome:'passed',explanation:'Polite',evidenceQuotes:['Please']});
 let body:any,crashPrepare=false,crashResult=false,allowed=true;
 const txSql:AgentTransactionalSql={query:sql.query,transaction:async fn=>{
  let prepared=false;
  const result=await sql.transaction(tx=>fn({query:async<T>(q:string,p?:unknown[])=>{
   const result=await tx.query<T>(q,p);
   if(q.startsWith('INSERT INTO naive_proxy_dispatch.attempts'))prepared=true;
   if(crashResult&&q.includes("SET state = 'completed'")&&p?.[1]==='naive_proxy_judge'){crashResult=false;throw Error('crashed final result');}
   return result;
  }}));
  if(crashPrepare&&prepared){crashPrepare=false;throw Error('lost prepare acknowledgement');}
  return result;
 }};
 const sink=new Map<string,unknown>();
 const recordCost=vi.fn(async(entry:Parameters<ServiceContext['recordCost']>[0])=>{sink.set(String(entry.meta.idempotencyKey),entry);});
 const ctx:ServiceContext={jobId:job,environment:'test',budgetMicroUsd:300_000,recordCost,recordProgress:async()=>{}};
 const messages=vi.fn(async(b:unknown)=>{body=b;return {id,model,stop_reason:'end_turn',content:[{type:'text',text}],usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0}};});
 const call=vi.fn(async()=>({id,source:'proxy',session_id:null,dialect:'anthropic',model,window:'immediate',billed_micro_usd:17,content_scope:'full',truncated:false,usage:{input:10,output:5,cache_read:0,cache_write:0},stop:'end_turn',response:{text,tool_calls:[],is_error:false,partial:false},request:{model,system:body.system,max_output_tokens:body.max_tokens,messages:body.messages}}));
 const proxy={messages,call} as unknown as VettaClient['proxy'];
 const authorizeTransaction=async(tx:AgentSqlExecutor)=>{const row=(await tx.query<{state:string}>('SELECT state FROM jobs WHERE id=$1',[job])).rows[0];if(!allowed||row.state==='cancelled')throw Error('evaluation revoked');};
 const judge=createAttemptAwareJudge(ctx,{jobId:job,model,maxOutputTokens:1000,reservationMicroUsd:60_000,client:()=>({proxy}),checkpoints:new PostgresTextCheckpointStore(txSql),budget:createNaiveProxyBudget(createWorkflowStageBudgetLedger(txSql),config),authorize:async()=>{if(!allowed)throw Error('evaluation revoked');return {knownSecrets:[]};}},{sql:txSql,config,authorizeTransaction});
 const accounting:JudgeOwnerRecoveryDeps={sql,authorizeAccounting:async()=>{},audit:{call},recordCost:async(_job,receipt)=>{sink.set(receipt.idempotencyKey,receipt);},legacyBudget:()=>createNaiveProxyBudget(new SharedJobBudgetLedger(sql),config),currentOperator:async()=> 'trusted-offline-operator'};
 const run=(callback:()=>Promise<unknown>)=>executeWorkflowStage({...input,share:.1,stage:{key:'judge-composition',input:{revision:1},isPending:()=>true}},callback);
 const attempts=()=>pg.query<{attempt:number;state:string;reservation_id:string}>('SELECT attempt,state,reservation_id FROM naive_proxy_dispatch.attempts ORDER BY attempt');
 return {judge,request,messages,call,sink,accounting,run,attempts,revoke:()=>{allowed=false;},crashPrepare:()=>{crashPrepare=true;},crashResult:()=>{crashResult=true;}};
}
it('settles measured v2 once, replays without another provider call, and binds the real stage envelope',async()=>{
 const f=fixture();await f.run(async()=>{
  expect(await f.judge(f.request)).toMatchObject({outcome:'passed'});
  expect(await f.judge(f.request)).toMatchObject({outcome:'passed'});
  expect(await sql.transaction(tx=>jobBudgetExposure(tx,job))).toMatchObject({committedMicroUsd:300_000});
 });
 expect(f.messages).toHaveBeenCalledTimes(1);expect(f.sink.size).toBe(1);
 expect((await pg.query('SELECT settled_micro_usd FROM agent_persistence.reservations')).rows).toEqual([{settled_micro_usd:17}]);
 expect((await pg.query('SELECT * FROM job_budget.stage_model_bindings')).rows).toHaveLength(1);
 expect((await f.attempts()).rows).toMatchObject([{attempt:1,state:'dispatched'}]);
});
it('requires explicit operator abandonment after prepare acknowledgement loss and preserves the retained target response',async()=>{
 const f=fixture(),target=vi.fn(async()=>f.request.response);
 await f.run(async()=>{
  const response=await target();f.crashPrepare();
  await expect(f.judge({...f.request,response})).rejects.toThrow('pending');
  expect(f.messages).not.toHaveBeenCalled();
  const req=new Request('https://offline.test/operator',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'recoverUndispatched',operationId:f.request.operationId,attempt:1,reason:'Trusted fixture operator verified unused hold'})});
  const recovered=await handleJudgeOwnerRecovery(req,job,f.accounting);expect(recovered.status).toBe(200);
  expect(await f.judge({...f.request,response})).toMatchObject({outcome:'passed'});
 });
 expect(target).toHaveBeenCalledTimes(1);expect(f.messages).toHaveBeenCalledTimes(1);
 expect((await f.attempts()).rows).toMatchObject([{attempt:1,state:'abandoned'},{attempt:2,state:'dispatched'}]);
 expect((await pg.query('SELECT r.settled_micro_usd FROM naive_proxy_dispatch.attempts a JOIN agent_persistence.reservations r ON r.id=a.reservation_id ORDER BY a.attempt')).rows).toEqual([{settled_micro_usd:0},{settled_micro_usd:17}]);
 expect((await pg.query('SELECT actor_id FROM naive_proxy_dispatch.recoveries')).rows).toEqual([{actor_id:'trusted-offline-operator'}]);
});
it('rejects cancellation between prepare and dispatch without a paid provider call',async()=>{
 const f=fixture();
 // The durable intent write occurs after prepare and before the immediate dispatch fence.
 const complete=PostgresTextCheckpointStore.prototype.complete;
 const spy=vi.spyOn(PostgresTextCheckpointStore.prototype,'complete').mockImplementation(async function(...args){
  await complete.apply(this,args);
  if(args[0].kind==='naive_proxy_intent')await pg.query("UPDATE jobs SET state='cancelled' WHERE id=$1",[job]);
 });
 try{await expect(f.run(async()=>f.judge(f.request))).rejects.toThrow();}finally{spy.mockRestore();}
 expect(f.messages).not.toHaveBeenCalled();expect((await f.attempts()).rows).toMatchObject([{state:'prepared'}]);
 expect((await pg.query('SELECT settled_micro_usd FROM agent_persistence.reservations')).rows).toEqual([{settled_micro_usd:null}]);
});
it('drains exact measured v2 accounting after evaluation revocation without constructing another dispatch',async()=>{
 const f=fixture();f.crashResult();
 await f.run(async()=>{await expect(f.judge(f.request)).rejects.toThrow();});
 f.revoke();await pg.query("UPDATE jobs SET state='cancelled' WHERE id=$1",[job]);
 const accounting=trustedJudgeAccountingDependencies({sql,audit:{call:f.call}});
 const result=await drainJudgeAccounting(job,accounting);
 expect(result).toMatchObject({status:'reconciled',scanned:1,reconciled:1,pending:0});
 expect(await drainJudgeAccounting(job,accounting)).toMatchObject({pending:0});
 expect(f.messages).toHaveBeenCalledTimes(1);expect(f.sink.size).toBe(0);
 expect((await pg.query('SELECT source,receipt_key,micro_usd FROM costs')).rows).toEqual([{source:'naive_proxy',receipt_key:'naive_proxy:req_'+'a'.repeat(26),micro_usd:17}]);
 expect((await pg.query('SELECT settled_micro_usd FROM agent_persistence.reservations')).rows).toEqual([{settled_micro_usd:17}]);
 await expect(f.judge(f.request)).rejects.toThrow('evaluation revoked');
});
it('preserves an existing legacy operation when attempt activation is enabled',async()=>{
 const f=fixture();vi.stubEnv('NAIVE_JUDGE_ATTEMPTS','0');
 await f.run(async()=>{expect(await f.judge(f.request)).toMatchObject({outcome:'passed'});vi.stubEnv('NAIVE_JUDGE_ATTEMPTS','1');expect(await selectJudgeAttemptMode(sql,job,f.request.operationId,true)).toBe('v1');expect(await f.judge(f.request)).toMatchObject({outcome:'passed'});});
 expect(f.messages).toHaveBeenCalledTimes(1);expect((await f.attempts()).rows).toHaveLength(0);
});

it('drains an explicitly abandoned retained v2 intent before fresh construction without synthetic cost or provider audit',async()=>{
 const f=fixture(),target=vi.fn(async()=>f.request.response);
 await f.run(async()=>{
  const response=await target();
  const complete=PostgresTextCheckpointStore.prototype.complete;
  const spy=vi.spyOn(PostgresTextCheckpointStore.prototype,'complete').mockImplementationOnce(async function(...args){
   await complete.apply(this,args);
   if(args[0].kind==='naive_proxy_intent')throw Error('worker lost acknowledgement after retained intent');
  });
  try{await expect(f.judge({...f.request,response})).rejects.toThrow('pending');}finally{spy.mockRestore();}
  expect((await pg.query("SELECT value FROM text_integration.checkpoints WHERE kind='naive_proxy_intent'")).rows).toHaveLength(1);
  expect(f.messages).not.toHaveBeenCalled();
  const req=new Request('https://offline.test/operator',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'recoverUndispatched',operationId:f.request.operationId,attempt:1,reason:'Trusted operator verified durable undispatched intent'})});
  expect((await handleJudgeOwnerRecovery(req,job,f.accounting)).status).toBe(200);
  const neverAudit=vi.fn(async()=>{throw Error('Unused attempt has no provider audit');});
  await drainRuntimeJudgeAccounting(job,sql,neverAudit as typeof fetch);
  expect(neverAudit).not.toHaveBeenCalled();expect(f.messages).not.toHaveBeenCalled();expect(f.sink.size).toBe(0);
  expect((await pg.query('SELECT * FROM costs')).rows).toHaveLength(0);
  expect(await f.judge({...f.request,response})).toMatchObject({outcome:'passed'});
 });
 expect(target).toHaveBeenCalledTimes(1);expect(f.messages).toHaveBeenCalledTimes(1);
 expect((await f.attempts()).rows).toMatchObject([{attempt:1,state:'abandoned'},{attempt:2,state:'dispatched'}]);
});

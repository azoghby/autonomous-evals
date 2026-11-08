import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {afterEach,expect,it,vi} from 'vitest';
import {PostgresBudgetLedger,type AgentTransactionalSql} from '@ae/core/agents/postgres-ports';
import {PostgresTextCheckpointStore} from '@ae/core/evals/integration/checkpoints';
import {PostgresNaiveProxyDispatchStore} from '@ae/core/judges/naive-proxy-dispatch-store';
import {createNaiveProxyBudget} from '@ae/core/judges/naive-proxy-budget';
import {proxyBillingDigest} from '@ae/core/judges/naive-proxy-reconcile';
import {drainJudgeAccounting,handleJudgeOwnerRecovery,type JudgeOwnerRecoveryDeps} from './judge-owner-recovery';
const opened:PGlite[]=[];
afterEach(async()=>{for(const pg of opened.splice(0))await pg.close();});
const jobId='00000000-0000-4000-8000-000000000123',customerId='00000000-0000-4000-8000-000000000124';
const config={jobId,period:'2026-11',jobCapMicroUsd:1000000,judgeCapMicroUsd:60000000,additionalScopes:[{key:`generic-text:${jobId}`,capMicroUsd:500000}]};
async function fixture(){
 const pg=new PGlite();opened.push(pg);
 for(const path of ['packages/core/src/agents/persistence-migrations/001-agent-persistence.sql','packages/core/src/evals/integration/migrations/001-text-integration.sql','packages/core/src/judges/migrations/001-proxy-dispatch.sql'])await pg.exec(readFileSync(path,'utf8'));
 await pg.exec('CREATE TABLE jobs(id uuid PRIMARY KEY,customer_id uuid,environment text,package text); CREATE TABLE owner_costs(key text PRIMARY KEY,receipt jsonb NOT NULL); CREATE TABLE costs(id uuid PRIMARY KEY,job_id uuid,micro_usd bigint,receipt_key text,source text); CREATE TABLE budget_reservations(id uuid PRIMARY KEY,job_id uuid,agent text,micro_usd bigint,released_at timestamptz)');
 await pg.exec(readFileSync('docs/naive-shared-budget-integration/sql/001-job-budget-authority.sql','utf8'));
 await pg.query('INSERT INTO jobs VALUES($1,$2,$3,$4)',[jobId,customerId,'test','text_eval']);
 const db:AgentTransactionalSql={query:(s,p)=>pg.query(s,p),transaction:fn=>pg.transaction(tx=>fn({query:(s,p)=>tx.query(s,p)}))};
 const checkpoints=new PostgresTextCheckpointStore(db),dispatch=new PostgresNaiveProxyDispatchStore(db,config);let actor='operator-one';
 const currentOperator=vi.fn(async()=>actor);
 const audit=vi.fn(async()=>{throw Error('unknown provider request');});
 const recordCost=vi.fn<JudgeOwnerRecoveryDeps['recordCost']>(async(_job,receipt)=>{await db.transaction(async tx=>{await tx.query('INSERT INTO owner_costs VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',[receipt.idempotencyKey,JSON.stringify(receipt)]);const row=(await tx.query<{same:boolean}>('SELECT receipt=$2::jsonb AS same FROM owner_costs WHERE key=$1',[receipt.idempotencyKey,JSON.stringify(receipt)])).rows[0];if(!row.same)throw Error('cost_conflict');});});
 const deps:JudgeOwnerRecoveryDeps={sql:db,currentOperator,authorizeAccounting:async()=>{if(!await currentOperator())throw Error('unauthorized');},audit:{call:audit},recordCost,legacyBudget:()=>createNaiveProxyBudget(new PostgresBudgetLedger(db),config)};
 async function complete(kind:string,id:string,inputDigest:string,value:unknown){const key={jobId,kind,id,inputDigest};const claim=await checkpoints.claim(key);if(claim.state!=='claimed')throw Error('claim');await checkpoints.complete(key,claim.token,value);}
 async function intent(operationId:string,v2=true,received=true,dispatchNow=true){
  const inputDigest='a'.repeat(64),request={model:'model',system:'system',max_output_tokens:10,messages:[{role:'user',content:'response'}]};
  const attempt=v2?await dispatch.prepare({jobId,operationId,inputDigest,amountMicroUsd:100}):undefined;
  if(attempt){if(dispatchNow&&attempt.state==='prepared')await dispatch.dispatch(attempt);}else await new PostgresBudgetLedger(db).reserve({reservationId:`naive-proxy:${proxyBillingDigest({jobId,operationId})}`,jobId,amountMicroUsd:100,scopes:[{key:`job:${jobId}`,capMicroUsd:1000000},{key:'agent:judge:2026-11',capMicroUsd:60000000}]});
  const id=proxyBillingDigest({jobId,operationId,...(v2?{attempt:1}:{})});
  await complete('naive_proxy_intent',id,inputDigest,{schemaVersion:v2?'naive_proxy_intent.v2':'naive_proxy_intent.v1',jobId,operationId,inputDigest,model:'model',maxOutputTokens:10,requestDigest:proxyBillingDigest(request),...(v2?{attempt:1,checkpointId:id,reservationId:`naive-proxy:${id}`}:{})});
  const requestId=`req_${'a'.repeat(25)}${operationId.endsWith('legacy')?'b':'c'}`;
  if(received)await complete('naive_proxy_received',id,inputDigest,{requestId,usage:null});
  audit.mockImplementation(async()=>({id:requestId,source:'proxy',session_id:null,dialect:'anthropic',model:'model',window:'immediate',billed_micro_usd:17,content_scope:'full',truncated:false,usage:{input:1,output:1,cache_read:0,cache_write:0},request}) as never);
  return {id,attempt,requestId};
 }
 const post=(body:unknown)=>handleJudgeOwnerRecovery(new Request('https://example.test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),jobId,deps);
 return {pg,db,dispatch,deps,intent,post,currentOperator,audit,recordCost,setActor:(value:string)=>{actor=value;}};
}
it('recovers measured v2 cost independently of revoked evaluator authority; preserves additional scopes and keyed replay',async()=>{
 const f=await fixture();await f.intent('measured');f.deps.authorizeAccounting=async()=>{};f.currentOperator.mockRejectedValue(Error('no request session'));
 f.deps.legacyBudget=()=>{throw Error('legacy evaluator authority revoked');};
 const first=await drainJudgeAccounting(jobId,f.deps);expect(first).toMatchObject({scanned:1,reconciled:1,pending:0});
 expect(await drainJudgeAccounting(jobId,f.deps)).toMatchObject({reconciled:1});
 expect((await f.pg.query('SELECT * FROM owner_costs')).rows).toHaveLength(1);expect(f.audit).toHaveBeenCalledTimes(1);
 const scopes=(await f.pg.query<{scopes:unknown}>('SELECT scopes FROM agent_persistence.reservations')).rows[0].scopes;
 expect(JSON.stringify(scopes)).toContain(`generic-text:${jobId}`);
});
it('discovers v1 and v2 with one bounded stable cursor; unknown requests stay fenced',async()=>{
 const f=await fixture();const legacy=await f.intent('legacy',false,false);const modern=await f.intent('modern',true,false);
 for(let n=0;n<26;n++)await f.intent(`unknown-${n}`,true,false);
 let cursor: string|undefined;let scanned=0;const cursors:string[]=[];
 do{const page=await drainJudgeAccounting(jobId,f.deps,cursor);scanned+=page.scanned;expect(page.reconciled).toBe(0);expect(page.pending).toBe(page.scanned);expect(page.scanned).toBeLessThanOrEqual(25);cursor=page.nextCursor??undefined;if(cursor)cursors.push(cursor);}while(cursor);
 expect(scanned).toBe(28);expect(cursors).toHaveLength(1);expect(f.audit).not.toHaveBeenCalled();
 expect((await f.pg.query('SELECT state FROM naive_proxy_dispatch.attempts WHERE checkpoint_id=$1',[modern.id])).rows[0]).toEqual({state:'dispatched'});
 expect((await f.pg.query('SELECT state FROM text_integration.checkpoints WHERE id=$1',[legacy.id])).rows[0]).toEqual({state:'completed'});
});
it('explicit recovery abandons exact undispatched attempt; duplicate replay preserves original actor/reason and never dispatches',async()=>{
 const f=await fixture();const first=await f.dispatch.prepare({jobId,operationId:'unused',inputDigest:'a'.repeat(64),amountMicroUsd:100});
 const body={action:'recoverUndispatched',operationId:'unused',attempt:1,reason:'Verified unused'};
 expect(await (await f.post(body)).json()).toEqual({status:'abandoned',attempt:1,replayed:false});
 f.setActor('operator-two');expect(await (await f.post({...body,reason:'New replay reason'})).json()).toMatchObject({replayed:true});
 const audit=(await f.pg.query('SELECT actor_id,reason FROM naive_proxy_dispatch.recoveries')).rows;expect(audit).toEqual([{actor_id:'operator-one',reason:'Verified unused'}]);
 expect((await f.pg.query('SELECT settled_micro_usd::text AS cost FROM agent_persistence.reservations WHERE id=$1',[first.reservationId])).rows[0]).toEqual({cost:'0'});
 expect(f.audit).not.toHaveBeenCalled();expect(f.recordCost).not.toHaveBeenCalled();
});
it('rejects dispatched and unknown attempts and untrusted policy/body fields',async()=>{
 const f=await fixture();await f.intent('sent');
 for(const body of [{action:'recoverUndispatched',operationId:'sent',attempt:1,reason:'never reopen'},{action:'recoverUndispatched',operationId:'unknown',attempt:1,reason:'unknown'}])expect((await f.post(body)).status).toBe(503);
 expect((await f.post({action:'recoverUndispatched',operationId:'sent',attempt:1,reason:'bad',jobCapMicroUsd:999999})).status).toBe(400);
 expect((await f.pg.query('SELECT * FROM naive_proxy_dispatch.recoveries')).rows).toHaveLength(0);
});
it('rotated operator inside the recovery transaction rolls back abandonment and settlement',async()=>{
 const f=await fixture();await f.dispatch.prepare({jobId,operationId:'unused',inputDigest:'a'.repeat(64),amountMicroUsd:100});
 f.currentOperator.mockResolvedValueOnce('operator-one').mockResolvedValueOnce('operator-one').mockResolvedValueOnce('operator-two');
 expect((await f.post({action:'recoverUndispatched',operationId:'unused',attempt:1,reason:'unused'})).status).toBe(503);
 expect((await f.pg.query('SELECT state FROM naive_proxy_dispatch.attempts')).rows).toEqual([{state:'prepared'}]);
 expect((await f.pg.query('SELECT settled_micro_usd FROM agent_persistence.reservations')).rows).toEqual([{settled_micro_usd:null}]);
});
it('rechecks canonical job ownership/environment in transaction',async()=>{
 const f=await fixture();await f.dispatch.prepare({jobId,operationId:'unused',inputDigest:'a'.repeat(64),amountMicroUsd:100});
 const original=f.db.query;let reads=0;f.db.query=async(s,p)=>{if(s.startsWith('SELECT input_digest,policy')&&++reads===1)await original("UPDATE jobs SET environment='live' WHERE id=$1",[jobId]);return original(s,p);};
 expect((await f.post({action:'recoverUndispatched',operationId:'unused',attempt:1,reason:'unused'})).status).toBe(503);
 expect((await f.pg.query('SELECT state FROM naive_proxy_dispatch.attempts')).rows[0]).toEqual({state:'prepared'});
});
it('all validation/auth responses are private and streamed body limits cannot be bypassed',async()=>{
 const f=await fixture();
 for(const body of [{action:'accounting',attempt:1},{action:'recoverUndispatched',operationId:'unused',attempt:1,reason:'x'.repeat(5000)}]){const res=await f.post(body);expect([400,413]).toContain(res.status);expect(res.headers.get('cache-control')).toContain('private, no-store');expect(res.headers.get('vary')).toBe('Cookie');}
 f.currentOperator.mockRejectedValue(Error('revoked operator'));const denied=await f.post({action:'accounting'});expect(denied.status).toBe(403);expect(denied.headers.get('cache-control')).toContain('no-store');
});

it('conflicting keyed cost remains pending and does not overwrite owner accounting',async()=>{
 const f=await fixture();const retained=await f.intent('conflict');
 await f.pg.query('INSERT INTO owner_costs VALUES($1,$2::jsonb)',[`naive_proxy:${retained.requestId}`,JSON.stringify({unrelated:true})]);
 expect(await drainJudgeAccounting(jobId,f.deps)).toMatchObject({reconciled:0,pending:1});
 expect((await f.pg.query('SELECT receipt FROM owner_costs')).rows).toEqual([{receipt:{unrelated:true}}]);
 expect((await f.pg.query('SELECT state FROM naive_proxy_dispatch.attempts')).rows).toEqual([{state:'dispatched'}]);
});

it('holds a canonical job row lock inside the recovery mutation transaction',async()=>{
 const f=await fixture();await f.dispatch.prepare({jobId,operationId:'locked-unused',inputDigest:'a'.repeat(64),amountMicroUsd:100});
 const original=f.db.transaction.bind(f.db);const statements:string[]=[];
 f.db.transaction=fn=>original(tx=>fn({query:(text,params)=>{statements.push(text);return tx.query(text,params);}}));
 expect((await f.post({action:'recoverUndispatched',operationId:'locked-unused',attempt:1,reason:'Confirmed unused'})).status).toBe(200);
 expect(statements.some(text=>text.includes('FROM jobs WHERE id=$1 FOR SHARE'))).toBe(true);
 expect((await f.pg.query('SELECT state FROM naive_proxy_dispatch.attempts')).rows).toEqual([{state:'abandoned'}]);
});

it('operator authorization occurs before canonical job and operation locks, then rechecks inside recovery',async()=>{
 const f=await fixture();await f.dispatch.prepare({jobId,operationId:'order-unused',inputDigest:'a'.repeat(64),amountMicroUsd:100});
 const original=f.db.transaction.bind(f.db),events:string[]=[];
 f.db.transaction=fn=>original(tx=>fn({query:(s,p)=>{events.push(s);return tx.query(s,p);}}));
 expect((await f.post({action:'recoverUndispatched',operationId:'order-unused',attempt:1,reason:'Verified unused'})).status).toBe(200);
 const jobLock=events.findIndex(s=>s.includes('FROM jobs WHERE id=$1 FOR UPDATE'));
 const operationLock=events.findIndex(s=>s.includes('FROM naive_proxy_dispatch.operations WHERE job_id=$1 AND operation_id=$2 FOR UPDATE'));
 expect(jobLock).toBeGreaterThanOrEqual(0);expect(operationLock).toBeGreaterThan(jobLock);
});

it('counts exact operator-abandoned retained intent as unused, then permits a fresh attempt without fabricated cost',async()=>{
 const f=await fixture();const retained=await f.intent('unused-intent',true,false,false);
 expect(await drainJudgeAccounting(jobId,f.deps)).toMatchObject({pending:1,unused:0});
 expect((await f.post({action:'recoverUndispatched',operationId:'unused-intent',attempt:1,reason:'Verified unused'})).status).toBe(200);
 expect(await drainJudgeAccounting(jobId,f.deps)).toMatchObject({pending:0,reconciled:0,unused:1});
 expect(f.audit).not.toHaveBeenCalled();expect(f.recordCost).not.toHaveBeenCalled();
 expect(await f.dispatch.prepare({jobId,operationId:'unused-intent',inputDigest:'a'.repeat(64),amountMicroUsd:100})).toMatchObject({attempt:2,state:'prepared'});
 expect((await f.pg.query('SELECT settled_micro_usd::text AS amount FROM agent_persistence.reservations WHERE id=$1',[retained.attempt!.reservationId])).rows).toEqual([{amount:'0'}]);
});
it('proves abandoned denied reservations unused only after explicit operator recovery',async()=>{
 const f=await fixture();await f.dispatch.prepare({jobId,operationId:'exhaust-allocation',inputDigest:'b'.repeat(64),amountMicroUsd:500000});
 await f.intent('denied-intent',true,false,false);
 expect(await drainJudgeAccounting(jobId,f.deps)).toMatchObject({pending:1,unused:0});
 expect((await f.post({action:'recoverUndispatched',operationId:'denied-intent',attempt:1,reason:'Verified denied and unused'})).status).toBe(200);
 expect(await drainJudgeAccounting(jobId,f.deps)).toMatchObject({pending:0,unused:1,reconciled:0});
 expect(f.audit).not.toHaveBeenCalled();expect(f.recordCost).not.toHaveBeenCalled();
});
it('missing or malformed recovery audit never clears an abandoned intent',async()=>{
 const f=await fixture();const retained=await f.intent('corrupt-audit',true,false,false);
 await f.pg.query('UPDATE agent_persistence.reservations SET settled_micro_usd=0 WHERE id=$1',[retained.attempt!.reservationId]);
 await f.pg.query("UPDATE naive_proxy_dispatch.attempts SET state='abandoned' WHERE job_id=$1 AND operation_id=$2",[jobId,'corrupt-audit']);
 expect(await drainJudgeAccounting(jobId,f.deps)).toMatchObject({pending:1,unused:0});
 await f.pg.query('INSERT INTO naive_proxy_dispatch.recoveries(job_id,operation_id,attempt,actor_id,reason) VALUES($1,$2,1,$3,$4)',[jobId,'corrupt-audit','','invalid actor']);
 expect(await drainJudgeAccounting(jobId,f.deps)).toMatchObject({pending:1,unused:0});
 expect(f.audit).not.toHaveBeenCalled();expect(f.recordCost).not.toHaveBeenCalled();
});

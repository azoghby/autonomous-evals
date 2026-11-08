/** Owner candidate. Accounting and explicit abandonment only; never constructs evaluation services. */
import { z } from 'zod';
import { type AgentSqlExecutor, type AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { PostgresTextCheckpointStore } from '@ae/core/evals/integration/checkpoints';
import { PostgresNaiveProxyDispatchStore } from '@ae/core/judges/naive-proxy-dispatch-store';
import { reconcileNaiveProxyBilling, proxyBillingDigest, type NaiveProxyReconcileDeps } from '@ae/core/judges/naive-proxy-reconcile';
import { createNaiveProxyBudget } from '@ae/core/judges/naive-proxy-budget';
import { lockJobBudget } from '@ae/core/db/job-budget-authority';
import { SharedJobBudgetLedger } from '@ae/core/db/job-budget-ledger';
import { canonicalJson } from '@ae/core/evals/text/freeze';

const hex=z.string().regex(/^[a-f0-9]{64}$/), operation=z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const integer=z.number().int().safe().positive();
const Policy=z.object({amountMicroUsd:integer,period:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),jobCapMicroUsd:integer,judgeCapMicroUsd:integer,additionalScopes:z.array(z.object({key:z.string().min(1).max(4096),capMicroUsd:z.number().int().safe().nonnegative()}).strict()).max(62)}).strict();
const Body=z.discriminatedUnion('action',[
 z.object({action:z.literal('accounting'),cursor:hex.optional()}).strict(),
 z.object({action:z.literal('recoverUndispatched'),operationId:operation,attempt:integer.max(2147483647),reason:z.string().trim().min(1).max(2000)}).strict(),
]);
export interface CanonicalJudgeJob {id:string;customer_id:string;environment:'test'|'live';package:string}
export interface JudgeAccountingDeps {
 sql:AgentTransactionalSql;
 /** Trusted internal server capability, or fresh operator checks captured by the endpoint. */
 authorizeAccounting():Promise<void>;
 audit:NaiveProxyReconcileDeps['proxy'];
 /** Atomic keyed cost sink independent of evaluator entitlement. */
 recordCost(job:CanonicalJudgeJob,receipt:Parameters<NaiveProxyReconcileDeps['recordCost']>[0]):Promise<void>;
 /** Legacy v1 settlement-only adapter; retain the existing v1 route as-is. */
 legacyBudget(job:CanonicalJudgeJob):NaiveProxyReconcileDeps['budget'];
}
export interface JudgeOwnerRecoveryDeps extends JudgeAccountingDeps {
 /** Rechecks the current operator allowlist/session, never a cached body identity. */
 currentOperator():Promise<string>;
}
const fail=():never=>{throw Error('judge_owner_recovery_unavailable');};
async function current(deps:JudgeOwnerRecoveryDeps,actor:string){if(!actor||await deps.currentOperator()!==actor)fail();}
async function job(sql:AgentSqlExecutor,id:string,lock=false):Promise<CanonicalJudgeJob>{
 const row=(await sql.query<CanonicalJudgeJob>(`SELECT id::text,customer_id::text,environment,package FROM jobs WHERE id=$1${lock?' FOR SHARE':''}`,[id])).rows[0];
 if(!row||row.id!==id||!z.uuid().safeParse(row.customer_id).success||!['test','live'].includes(row.environment))return fail();return row;
}
async function sameJob(sql:AgentSqlExecutor,expected:CanonicalJudgeJob,lock=false){const now=await job(sql,expected.id,lock);if(canonicalJson(now)!==canonicalJson(expected))fail();}
async function policy(sql:AgentSqlExecutor,jobId:string,operationId:string){
 const row=(await sql.query<{input_digest:string;policy:unknown}>('SELECT input_digest,policy FROM naive_proxy_dispatch.operations WHERE job_id=$1 AND operation_id=$2',[jobId,operationId])).rows[0];
 if(!row||!hex.safeParse(row.input_digest).success) return fail();return {...row,policy:Policy.parse(row.policy)};
}
const UnusedIntent=z.object({schemaVersion:z.literal('naive_proxy_intent.v2'),jobId:z.string(),operationId:operation,attempt:integer.max(2147483647),inputDigest:hex,model:z.string().min(1),requestDigest:hex,maxOutputTokens:integer.max(4096),checkpointId:hex,reservationId:z.string()}).strict();
/** Never infer non-dispatch from absent provider evidence alone. Terminal immutable
 * abandonment, its audit, and the exact unused reservation must agree. */
async function proveUnused(deps:JudgeAccountingDeps,jobId:string,operationId:string,attempt:number,id:string,rawIntent:unknown,immutable:Awaited<ReturnType<typeof policy>>,reserved:boolean){
 const intent=UnusedIntent.parse(rawIntent);
 if(intent.jobId!==jobId||intent.operationId!==operationId||intent.attempt!==attempt||intent.checkpointId!==id||intent.reservationId!==`naive-proxy:${id}`||intent.inputDigest!==immutable.input_digest)fail();
 const audit=(await deps.sql.query<{actor_id:string;reason:string;recovered_at:unknown}>('SELECT actor_id,reason,recovered_at FROM naive_proxy_dispatch.recoveries WHERE job_id=$1 AND operation_id=$2 AND attempt=$3',[jobId,operationId,attempt])).rows[0];
 if(!audit||!z.string().trim().min(1).max(200).safeParse(audit.actor_id).success||!z.string().trim().min(1).max(2000).safeParse(audit.reason).success||!audit.recovered_at||!Number.isFinite(new Date(audit.recovered_at as string).getTime()))fail();
 const reservation=(await deps.sql.query<{job_id:string;amount_micro_usd:string|number;scopes:unknown;first_result:{ok?:boolean;reservationId?:string}|null;settled_micro_usd:string|number|null}>('SELECT job_id,amount_micro_usd,scopes,first_result,settled_micro_usd FROM agent_persistence.reservations WHERE id=$1',[intent.reservationId])).rows[0];
 const expectedScopes=[{key:`job:${jobId}`,capMicroUsd:immutable.policy.jobCapMicroUsd},{key:`agent:judge:${immutable.policy.period}`,capMicroUsd:immutable.policy.judgeCapMicroUsd},...immutable.policy.additionalScopes].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
 if(!reservation||!reservation.first_result||reservation.job_id!==jobId||Number(reservation.amount_micro_usd)!==immutable.policy.amountMicroUsd||canonicalJson(reservation.scopes)!==canonicalJson(expectedScopes)||reservation.first_result?.reservationId!==intent.reservationId)fail();
 const result=reservation.first_result;if(!result)return fail();
 if(reserved?result.ok!==true||reservation.settled_micro_usd===null||Number(reservation.settled_micro_usd)!==0:result.ok!==false||reservation.settled_micro_usd!==null)fail();
 const evidence=await deps.sql.query(`SELECT 1 FROM text_integration.checkpoints WHERE job_id=$1 AND id=$2 AND (kind IN ('naive_proxy_received','naive_proxy_billing') OR (kind='naive_proxy_judge' AND state='completed')) LIMIT 1`,[jobId,id]);
 if(evidence.rows.length)fail();
}
export const JUDGE_ACCOUNTING_BATCH=25;
/** Call before paid factory authorization, including cancelled jobs/revoked evaluation plans.
 * The cursor covers both intent versions. Unknown/malformed receipts stay pending and fenced. */
export async function drainJudgeAccounting(jobId:string,deps:JudgeAccountingDeps,cursor=''){
 if(!z.uuid().safeParse(jobId).success||cursor!==''&&!hex.safeParse(cursor).success)fail();
 await deps.authorizeAccounting();const owner=await job(deps.sql,jobId);
 const selected=await deps.sql.query<{id:string;value:unknown}>(`SELECT c.id,c.value FROM text_integration.checkpoints c JOIN jobs j ON j.id::text=c.job_id
 WHERE j.id=$1 AND j.customer_id=$2 AND j.environment=$3 AND c.kind='naive_proxy_intent' AND c.state='completed' AND c.id>$4 ORDER BY c.id LIMIT 26`,[jobId,owner.customer_id,owner.environment,cursor]);
 let reconciled=0,pending=0,unused=0;const rows=selected.rows.slice(0,JUDGE_ACCOUNTING_BATCH);
 for(const row of rows){
  await deps.authorizeAccounting();await sameJob(deps.sql,owner);
  try{
   const intent=z.object({schemaVersion:z.enum(['naive_proxy_intent.v1','naive_proxy_intent.v2']),jobId:z.literal(jobId),operationId:operation,attempt:integer.max(2147483647).optional(),inputDigest:hex}).passthrough().parse(row.value);
   const attempt=intent.schemaVersion==='naive_proxy_intent.v2'?intent.attempt:undefined;
   if(intent.schemaVersion==='naive_proxy_intent.v2'&&attempt===undefined||row.id!==proxyBillingDigest({jobId,operationId:intent.operationId,...(attempt===undefined?{}:{attempt})}))fail();
   let budget:NaiveProxyReconcileDeps['budget'];
   if(attempt!==undefined){const immutable=await policy(deps.sql,jobId,intent.operationId);if(immutable.input_digest!==intent.inputDigest)fail();
    const retained=(await deps.sql.query<{checkpoint_id:string;reservation_id:string;state:string;reserved:boolean}>('SELECT checkpoint_id,reservation_id,state,reserved FROM naive_proxy_dispatch.attempts WHERE job_id=$1 AND operation_id=$2 AND attempt=$3',[jobId,intent.operationId,attempt])).rows[0];
    if(!retained||retained.checkpoint_id!==row.id||retained.reservation_id!==`naive-proxy:${row.id}`)fail();
    if(retained.state==='abandoned'){await proveUnused(deps,jobId,intent.operationId,attempt,row.id,row.value,immutable,retained.reserved);unused++;continue;}
    if(retained.state!=='dispatched')fail();
    // Settlement cannot reserve. Extra scopes remain attached to the original SQL reservation.
    budget=createNaiveProxyBudget(new SharedJobBudgetLedger(deps.sql),{jobId,...immutable.policy});
   }else budget=deps.legacyBudget(owner);
   await reconcileNaiveProxyBilling({jobId,operationId:intent.operationId,...(attempt===undefined?{}:{attempt})},{checkpoints:new PostgresTextCheckpointStore(deps.sql),proxy:deps.audit,budget,recordCost:async receipt=>{await deps.authorizeAccounting();await sameJob(deps.sql,owner);await deps.recordCost(owner,receipt);}});reconciled++;
  }catch{pending++;}
 }
 await deps.authorizeAccounting();await sameJob(deps.sql,owner);
 return {status:pending?'requires_reconciliation':'reconciled',scanned:rows.length,reconciled,unused,pending,remaining:selected.rows.length>JUDGE_ACCOUNTING_BATCH,nextCursor:selected.rows.length>JUDGE_ACCOUNTING_BATCH?rows.at(-1)!.id:null};
}
const headers={'Cache-Control':'private, no-store, max-age=0',Vary:'Cookie','X-Content-Type-Options':'nosniff'};
const response=(value:unknown,status=200)=>Response.json(value,{status,headers});
async function bounded(req:Request){
 const length=req.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>4096))throw Error('body_large');
 if(req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!req.body)throw Error('body_invalid');
 const reader=req.body.getReader();let size=0;const parts:Uint8Array[]=[];
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4096){await reader.cancel();throw Error('body_large');}parts.push(part.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
export async function handleJudgeOwnerRecovery(req:Request,jobId:string,deps:JudgeOwnerRecoveryDeps):Promise<Response>{
 let actor:string;try{actor=await deps.currentOperator();if(!actor)fail();}catch{return response({error:'Operator required'},403);}
 if(!z.uuid().safeParse(jobId).success)return response({error:'Invalid job'},400);
 let body:z.infer<typeof Body>;try{body=Body.parse(await bounded(req));}catch(error){return response({error:'Invalid recovery request'},error instanceof Error&&error.message==='body_large'?413:400);}
 try{
  await current(deps,actor);
  if(body.action==='accounting')return response(await drainJudgeAccounting(jobId,{...deps,authorizeAccounting:()=>current(deps,actor)},body.cursor));
  const owner=await job(deps.sql,jobId),immutable=await policy(deps.sql,jobId,body.operationId);
  const store=new PostgresNaiveProxyDispatchStore(deps.sql,{jobId,...immutable.policy},{
   beforeTransition:async(tx,phase)=>{if(phase!=='recover')fail();await current(deps,actor);await lockJobBudget(tx,jobId);await sameJob(tx,owner,true);},
   ledger:tx=>new SharedJobBudgetLedger({query:tx.query.bind(tx),transaction:fn=>fn(tx)}),
  });
  const result=await store.recoverUndispatched({jobId,operationId:body.operationId,inputDigest:immutable.input_digest,attempt:body.attempt},async(tx,identity)=>{
   await current(deps,actor);await sameJob(tx,owner,true);const locked=await policy(tx,jobId,identity.operationId);
   if(identity.attempt!==body.attempt||identity.inputDigest!==immutable.input_digest||canonicalJson(locked)!==canonicalJson(immutable))fail();
   return {actorId:actor,reason:body.reason};
  });
  await current(deps,actor);return response({status:'abandoned',...result});
 }catch{return response({error:'Judge recovery requires reconciliation'},503);}
}

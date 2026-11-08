/** Explicit owner recovery for proven-undispatched proxy attempts. No paid/provider API. */
import { randomUUID } from 'node:crypto';
import { PostgresBudgetLedger, type AgentSqlExecutor, type AgentTransactionalSql } from '../agents/postgres-ports';
import { canonicalJson } from '../evals/text/freeze';
import { proxyBillingDigest } from './naive-proxy-reconcile';

export interface NaiveProxyDispatchInput { jobId:string; operationId:string; inputDigest:string; amountMicroUsd:number }
export interface NaiveProxyDispatchAttempt {
 jobId:string; operationId:string; inputDigest:string; attempt:number; checkpointId:string; reservationId:string; token:string;
 state:'prepared'|'denied'|'dispatched'|'abandoned';
}
export interface NaiveProxyDispatchPort {
 prepare(input:NaiveProxyDispatchInput):Promise<NaiveProxyDispatchAttempt>;
 lookup(input:NaiveProxyDispatchInput):Promise<NaiveProxyDispatchAttempt|null>;
 dispatch(attempt:NaiveProxyDispatchAttempt):Promise<void>;
 isUndispatched(attempt:NaiveProxyDispatchAttempt):Promise<boolean>;
}
export interface NaiveProxyRecoveryIdentity {jobId:string;operationId:string;inputDigest:string;attempt:number}
export type NaiveProxyRecoveryAuthorization = (tx:AgentSqlExecutor, identity:Readonly<NaiveProxyRecoveryIdentity>)=>Promise<{actorId:string;reason:string}>;
export interface NaiveProxyDispatchConfig {jobId:string;period:string;jobCapMicroUsd:number;judgeCapMicroUsd:number;additionalScopes?:readonly {key:string;capMicroUsd:number}[]}
type AttemptRow={attempt:number;token:string;checkpoint_id:string;reservation_id:string;state:NaiveProxyDispatchAttempt['state']|'abandoned';reserved:boolean};
type OperationRow={input_digest:string;policy:unknown;active_attempt:number};
const fail=():never=>{throw new Error('naive_proxy_dispatch_unavailable');};
function identity(input:NaiveProxyRecoveryIdentity|NaiveProxyDispatchInput){
 if(!/^[A-Za-z0-9_-]{1,96}$/.test(input.jobId)||!/^[A-Za-z0-9_.:-]{1,200}$/.test(input.operationId)||!/^[a-f0-9]{64}$/.test(input.inputDigest))fail();
}
export function naiveProxyAttemptCheckpointId(jobId:string,operationId:string,attempt:number):string {
 if(!Number.isSafeInteger(attempt)||attempt<1||attempt>2147483647)fail();
 return proxyBillingDigest({jobId,operationId,attempt});
}
export function naiveProxyAttemptReservationId(jobId:string,operationId:string,attempt:number):string {
 return `naive-proxy:${naiveProxyAttemptCheckpointId(jobId,operationId,attempt)}`;
}
const boundLedger=(tx:AgentSqlExecutor)=>new PostgresBudgetLedger({query:tx.query.bind(tx),transaction:fn=>fn(tx)});
/** All prepare/recover/dispatch transitions lock the same operation row. Never expire a dispatch
 * fence. A lost dispatch acknowledgement remains dispatched even if no provider call followed.
 * The explicit authorization callback runs INSIDE the recovery transaction after row locking;
 * it must validate current owner authority from trusted state, never customer request flags. */
export class PostgresNaiveProxyDispatchStore implements NaiveProxyDispatchPort {
 private readonly config:NaiveProxyDispatchConfig;
 constructor(private readonly db:AgentTransactionalSql,config:NaiveProxyDispatchConfig){
  this.config={...config,additionalScopes:config.additionalScopes?.map(s=>({...s})).sort((a,b)=>a.key.localeCompare(b.key))};
  if(!/^[A-Za-z0-9_-]{1,96}$/.test(config.jobId)||!/^[A-Za-z0-9_-]{1,80}$/.test(config.period)||[config.jobCapMicroUsd,config.judgeCapMicroUsd].some(n=>!Number.isSafeInteger(n)||n<=0))fail();
  const extra=this.config.additionalScopes??[];
  if(extra.length>62||new Set(extra.map(s=>s.key)).size!==extra.length||extra.some(s=>typeof s.key!=='string'||!s.key.length||s.key.length>4096||/[\u0000\uD800-\uDFFF]/u.test(s.key)||s.key===`job:${config.jobId}`||s.key===`agent:judge:${config.period}`||!Number.isSafeInteger(s.capMicroUsd)||s.capMicroUsd<0))fail();
 }
 async prepare(raw:NaiveProxyDispatchInput):Promise<NaiveProxyDispatchAttempt>{
  const input={...raw};identity(input);if(input.jobId!==this.config.jobId||!Number.isSafeInteger(input.amountMicroUsd)||input.amountMicroUsd<=0)fail();
  const policy={amountMicroUsd:input.amountMicroUsd,period:this.config.period,jobCapMicroUsd:this.config.jobCapMicroUsd,judgeCapMicroUsd:this.config.judgeCapMicroUsd,additionalScopes:this.config.additionalScopes??[]};
  return this.db.transaction(async tx=>{
   // Historical dispatch identity cannot be silently converted into a fresh attempt.
   const legacy=proxyBillingDigest({jobId:input.jobId,operationId:input.operationId});
   await tx.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[input.jobId,legacy]);
   if((await tx.query(`SELECT 1 FROM text_integration.checkpoints WHERE job_id=$1 AND kind IN ('naive_proxy_judge','naive_proxy_intent','naive_proxy_received') AND id=$2 UNION ALL SELECT 1 FROM agent_persistence.reservations WHERE id=$3 LIMIT 1`,[input.jobId,legacy,`naive-proxy:${legacy}`])).rows.length)fail();
   await tx.query(`INSERT INTO naive_proxy_dispatch.operations(job_id,operation_id,input_digest,policy,active_attempt,legacy_checkpoint_id) VALUES($1,$2,$3,$4::jsonb,1,$5) ON CONFLICT DO NOTHING`,[input.jobId,input.operationId,input.inputDigest,JSON.stringify(policy),legacy]);
   const op=(await tx.query<OperationRow>('SELECT * FROM naive_proxy_dispatch.operations WHERE job_id=$1 AND operation_id=$2 FOR UPDATE',[input.jobId,input.operationId])).rows[0];
   if(!op||op.input_digest!==input.inputDigest||canonicalJson(op.policy)!==canonicalJson(policy))fail();
   let attempt=op.active_attempt;
   let row:AttemptRow|undefined=(await tx.query<AttemptRow>('SELECT * FROM naive_proxy_dispatch.attempts WHERE job_id=$1 AND operation_id=$2 AND attempt=$3',[input.jobId,input.operationId,attempt])).rows[0];
   if(row?.state==='abandoned'){
    if(attempt>=2147483647)fail();attempt++;
    await tx.query('UPDATE naive_proxy_dispatch.operations SET active_attempt=$3 WHERE job_id=$1 AND operation_id=$2',[input.jobId,input.operationId,attempt]);row=undefined;
   }
   if(!row){
    const checkpointId=naiveProxyAttemptCheckpointId(input.jobId,input.operationId,attempt),reservationId=`naive-proxy:${checkpointId}`;
    const result=await boundLedger(tx).reserve({reservationId,jobId:input.jobId,amountMicroUsd:input.amountMicroUsd,scopes:[{key:`job:${input.jobId}`,capMicroUsd:this.config.jobCapMicroUsd},{key:`agent:judge:${this.config.period}`,capMicroUsd:this.config.judgeCapMicroUsd},...(this.config.additionalScopes??[])]});
    row={attempt,token:randomUUID(),checkpoint_id:checkpointId,reservation_id:reservationId,state:result.ok?'prepared':'denied',reserved:result.ok};
    await tx.query('INSERT INTO naive_proxy_dispatch.attempts(job_id,operation_id,attempt,token,checkpoint_id,reservation_id,state,reserved) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[input.jobId,input.operationId,attempt,row.token,checkpointId,reservationId,row.state,row.reserved]);
   }
   if(row.state==='abandoned')return fail();
   return {jobId:input.jobId,operationId:input.operationId,inputDigest:input.inputDigest,attempt:row.attempt,token:row.token,checkpointId:row.checkpoint_id,reservationId:row.reservation_id,state:row.state};
  });
 }
 async dispatch(raw:NaiveProxyDispatchAttempt):Promise<void>{
  const input={...raw};identity(input);
  await this.db.transaction(async tx=>{
   const op=(await tx.query<OperationRow>('SELECT * FROM naive_proxy_dispatch.operations WHERE job_id=$1 AND operation_id=$2 FOR UPDATE',[input.jobId,input.operationId])).rows[0];
   if(!op||op.input_digest!==input.inputDigest||op.active_attempt!==input.attempt||input.jobId!==this.config.jobId)fail();
   const row=(await tx.query<AttemptRow>('SELECT * FROM naive_proxy_dispatch.attempts WHERE job_id=$1 AND operation_id=$2 AND attempt=$3',[input.jobId,input.operationId,input.attempt])).rows[0];
   if(!row||row.state!=='prepared'||row.token!==input.token||row.checkpoint_id!==input.checkpointId||row.reservation_id!==input.reservationId)fail();
   await tx.query(`UPDATE naive_proxy_dispatch.attempts SET state='dispatched' WHERE job_id=$1 AND operation_id=$2 AND attempt=$3`,[input.jobId,input.operationId,input.attempt]);
  });
 }
 /** Read-only recovery of a lost prepare acknowledgement; never creates a hold or attempt. */
 async lookup(raw:NaiveProxyDispatchInput):Promise<NaiveProxyDispatchAttempt|null>{
  const input={...raw};identity(input);if(input.jobId!==this.config.jobId||!Number.isSafeInteger(input.amountMicroUsd)||input.amountMicroUsd<=0)fail();
  const policy={amountMicroUsd:input.amountMicroUsd,period:this.config.period,jobCapMicroUsd:this.config.jobCapMicroUsd,judgeCapMicroUsd:this.config.judgeCapMicroUsd,additionalScopes:this.config.additionalScopes??[]};
  return this.db.transaction(async tx=>{
   const op=(await tx.query<OperationRow>('SELECT * FROM naive_proxy_dispatch.operations WHERE job_id=$1 AND operation_id=$2 FOR UPDATE',[input.jobId,input.operationId])).rows[0];
   if(!op)return null;
   if(op.input_digest!==input.inputDigest||canonicalJson(op.policy)!==canonicalJson(policy))fail();
   const row=(await tx.query<AttemptRow>('SELECT * FROM naive_proxy_dispatch.attempts WHERE job_id=$1 AND operation_id=$2 AND attempt=$3',[input.jobId,input.operationId,op.active_attempt])).rows[0];
   return row?{jobId:input.jobId,operationId:input.operationId,inputDigest:input.inputDigest,attempt:row.attempt,token:row.token,checkpointId:row.checkpoint_id,reservationId:row.reservation_id,state:row.state}:null;
  });
 }
 async isUndispatched(raw:NaiveProxyDispatchAttempt):Promise<boolean>{
  const input={...raw};identity(input);
  return this.db.transaction(async tx=>{
   const op=(await tx.query<OperationRow>('SELECT * FROM naive_proxy_dispatch.operations WHERE job_id=$1 AND operation_id=$2 FOR UPDATE',[input.jobId,input.operationId])).rows[0];
   if(!op||op.input_digest!==input.inputDigest||input.jobId!==this.config.jobId)return false;
   const row=(await tx.query<AttemptRow>('SELECT * FROM naive_proxy_dispatch.attempts WHERE job_id=$1 AND operation_id=$2 AND attempt=$3',[input.jobId,input.operationId,input.attempt])).rows[0];
   // Abandonment is immutable proof of no dispatch, including after a newer attempt starts.
   // Stale workers must hold their outer result rather than cache a terminal failure.
   return !!row&&row.token===input.token&&row.checkpoint_id===input.checkpointId&&row.reservation_id===input.reservationId&&(row.state==='abandoned'||op.active_attempt===input.attempt&&(row.state==='prepared'||row.state==='denied'));
  });
 }
 async recoverUndispatched(raw:NaiveProxyRecoveryIdentity,authorize:NaiveProxyRecoveryAuthorization):Promise<{attempt:number;replayed:boolean}>{
  const input={...raw};identity(input);if(input.jobId!==this.config.jobId||!Number.isSafeInteger(input.attempt)||input.attempt<1||input.attempt>2147483647||typeof authorize!=='function')fail();
  return this.db.transaction(async tx=>{
   const op=(await tx.query<OperationRow>('SELECT * FROM naive_proxy_dispatch.operations WHERE job_id=$1 AND operation_id=$2 FOR UPDATE',[input.jobId,input.operationId])).rows[0];
   if(!op||op.input_digest!==input.inputDigest)fail();
   const authority=await authorize(tx,Object.freeze({...input}));
   if(!authority||typeof authority.actorId!=='string'||!authority.actorId.trim()||authority.actorId.length>200||typeof authority.reason!=='string'||!authority.reason.trim()||authority.reason.length>2000)fail();
   const row=(await tx.query<AttemptRow>('SELECT * FROM naive_proxy_dispatch.attempts WHERE job_id=$1 AND operation_id=$2 AND attempt=$3',[input.jobId,input.operationId,input.attempt])).rows[0];
   if(!row||row.state==='dispatched')fail();
   if(row.state==='abandoned')return {attempt:input.attempt,replayed:true};
   if(op.active_attempt!==input.attempt)fail();
   if(row.reserved){const settled=await boundLedger(tx).settle(row.reservation_id,0);if(settled.settledMicroUsd!==0)fail();}
   await tx.query(`UPDATE naive_proxy_dispatch.attempts SET state='abandoned' WHERE job_id=$1 AND operation_id=$2 AND attempt=$3`,[input.jobId,input.operationId,input.attempt]);
   await tx.query('INSERT INTO naive_proxy_dispatch.recoveries(job_id,operation_id,attempt,actor_id,reason) VALUES($1,$2,$3,$4,$5)',[input.jobId,input.operationId,input.attempt,authority.actorId,authority.reason]);
   return {attempt:input.attempt,replayed:false};
  });
 }
}

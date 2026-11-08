import { SharedJobBudgetLedger } from '@ae/core/db/job-budget-ledger';
import { lockJobBudget } from '@ae/core/db/job-budget-authority';
import { createHash } from 'node:crypto';
import { encryptJson, decryptJson } from '@ae/core/storage/crypto';
import { type AgentSqlExecutor, type AgentTransactionalSql } from '@ae/core/agents/postgres-ports';
import { authorizeTask, type InternalTask, type FreshOwner, type ConfiguredPin } from './naive-internal-store';
export type CopilotCreateBody = Record<string,unknown> & {agent_id:string;agent_version:number;budget_micro_usd:number;message:string};
export interface PrepareDispatch { id:string; task:InternalTask; threadId:string; turnId:string; requestDigest:string; body:CopilotCreateBody; budget:{amountMicroUsd:number;jobCapMicroUsd:number;agentMonth:string;agentMonthCapMicroUsd:number;customerDay:string;customerDayCapMicroUsd:number} }
type Identity = Omit<PrepareDispatch,'body'> & {bodyDigest:string;idempotencyKey:string;reservationId:string};
export interface DispatchRecord extends Identity {state:'reserved'|'ambiguous'|'running'|'completed'|'failed'|'revoked';revision:number;sessionId:string|null;leaseOwner:string|null;leaseUntil:number;consumedMicroUsd:number|null}
type Row={identity:Identity;state:DispatchRecord['state'];revision:number;session_id:string|null;lease_owner:string|null;lease_until:string|number;consumed_micro_usd:string|number|null;body_ciphertext:string};
const fail=():never=>{throw new Error('copilot_dispatch_rejected');};
function canonical(v:unknown):string { if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';if(v!==null&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';const s=JSON.stringify(v);if(s===undefined)fail();return s; }
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
function record(r:Row):DispatchRecord{return {...r.identity,state:r.state,revision:r.revision,sessionId:r.session_id,leaseOwner:r.lease_owner,leaseUntil:Number(r.lease_until),consumedMicroUsd:r.consumed_micro_usd===null?null:Number(r.consumed_micro_usd)};}
const adapter=(tx:AgentSqlExecutor):AgentTransactionalSql=>({...tx,transaction:fn=>fn(tx)});
/** Private dedicated store. Callers supply trusted server policy and a fresh session owner resolver.
 * All SQL transactions must be pinned READ COMMITTED, rollback on error, without automatic retries.
 * Raw capability-bearing bodies never enter generic task persistence or diagnostics. */
export class CopilotDispatchStore {
 constructor(private db:AgentTransactionalSql,private key?:Buffer,private freshOwner?:FreshOwner,private currentPin?:()=>ConfiguredPin){}
 private async authority(tx:AgentSqlExecutor,r:Identity,owner=false,terminal=false){
  const pin=this.currentPin?.();if(!pin||pin.agentId!==r.task.agentId||pin.agentVersion!==r.task.agentVersion||r.task.role!=='copilot')fail();
  if(owner){const fresh=this.freshOwner;if(!fresh)return fail();const actor=await fresh(tx);if(actor.customerId!==r.task.customerId)fail();}
  if(terminal){
   const t=r.task; const job=(await tx.query<{customer_id:string;environment:string}>('SELECT customer_id,environment FROM jobs WHERE id=$1 FOR SHARE',[t.jobId])).rows[0];
   const cred=(await tx.query("SELECT id FROM naive_internal.credentials WHERE id=$1 AND role='copilot' AND agent_id=$2 AND agent_version=$3 AND revoked_at IS NULL FOR SHARE",[t.credentialId,t.agentId,t.agentVersion])).rows;
   const task=(await tx.query('SELECT id FROM naive_internal.tasks WHERE id=$1 AND revoked_at IS NULL FOR UPDATE',[t.id])).rows;
   if(!job||job.customer_id!==t.customerId||job.environment!==t.environment||cred.length!==1||task.length!==1)fail();return;
  }
  await authorizeTask(tx,r.task,{id:r.task.credentialId,role:'copilot',agentId:r.task.agentId,agentVersion:r.task.agentVersion},{agentId:r.task.agentId,agentVersion:r.task.agentVersion});
 }
 private async peek(tx:AgentSqlExecutor,id:string){return (await tx.query<Row>('SELECT * FROM naive_copilot.dispatches WHERE id=$1',[id])).rows[0];}
 private async row(tx:AgentSqlExecutor,id:string){return (await tx.query<Row>('SELECT * FROM naive_copilot.dispatches WHERE id=$1 FOR UPDATE',[id])).rows[0];}
 private async time(tx:AgentSqlExecutor){return Number((await tx.query<{n:string}>('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS n')).rows[0]?.n);}
 async get(id:string){const r=(await this.db.query<Row>('SELECT * FROM naive_copilot.dispatches WHERE id=$1',[id])).rows[0];return r?record(r):null;}
 async prepare(input:PrepareDispatch):Promise<DispatchRecord>{try{return await this.db.transaction(async tx=>{
  const {body,...rest}=input,b=input.budget;
  if(!/^[A-Za-z0-9_-]{1,160}$/.test(input.id)||![input.threadId,input.turnId].every(x=>typeof x==='string'&&x.length>0&&x.length<=160)||! /^[a-f0-9]{64}$/.test(input.requestDigest))fail();
  if((!Number.isSafeInteger(b.amountMicroUsd)||b.amountMicroUsd<1||b.amountMicroUsd>300000)||b.agentMonthCapMicroUsd!==20000000||b.customerDayCapMicroUsd!==2000000||!Number.isSafeInteger(b.jobCapMicroUsd)||b.jobCapMicroUsd<1||! /^[A-Za-z0-9_-]+$/.test(b.agentMonth)||! /^\d{4}-\d{2}-\d{2}$/.test(b.customerDay))fail();
  if(body.agent_id!==input.task.agentId||body.agent_version!==input.task.agentVersion||body.budget_micro_usd!==b.amountMicroUsd||typeof body.message!=='string'||body.message.length>100000)fail();
  const identity:Identity={...rest,bodyDigest:digest(body),idempotencyKey:`copilot:${input.id}`,reservationId:`copilot:${input.id}`};
  await lockJobBudget(tx,input.task.jobId);await this.authority(tx,identity,true);
  const old=await this.row(tx,input.id);if(old){if(canonical(old.identity)!==canonical(identity))fail();return record(old);}
  const ledger=new SharedJobBudgetLedger(adapter(tx));const reserved=await ledger.reserve({reservationId:identity.reservationId,jobId:input.task.jobId,amountMicroUsd:b.amountMicroUsd,scopes:[{key:`job:${input.task.jobId}`,capMicroUsd:b.jobCapMicroUsd},{key:`agent:copilot:${b.agentMonth}`,capMicroUsd:b.agentMonthCapMicroUsd},{key:`copilot-customer-day:${input.task.customerId}:${input.task.environment}:${b.customerDay}`,capMicroUsd:b.customerDayCapMicroUsd}]});if(!reserved.ok)fail();
  await tx.query("INSERT INTO naive_copilot.dispatches(id,identity,body_ciphertext,state) VALUES($1,$2::jsonb,$3,'reserved')",[input.id,JSON.stringify(identity),encryptJson({identityDigest:digest(identity),body},this.key)]);
  return record((await this.row(tx,input.id))!);
 });}catch{return fail();}}
 async claim(id:string,owner:string,leaseMs:number){if(!owner||owner.length>160||!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>60000)fail();return this.db.transaction(async tx=>{const r=await this.row(tx,id),n=await this.time(tx);if(!r||r.state==='revoked'||r.state==='failed'||Number(r.lease_until)>n)return null;await tx.query('UPDATE naive_copilot.dispatches SET lease_owner=$2,lease_until=$3,revision=revision+1 WHERE id=$1',[id,owner,n+leaseMs]);return record((await this.row(tx,id))!);});}
 private async fenced(tx:AgentSqlExecutor,id:string,owner:string,revision:number){const r=await this.row(tx,id);if(!r||r.revision!==revision||r.lease_owner!==owner||Number(r.lease_until)<=await this.time(tx))return null;return r;}
 async beginCreate(id:string,owner:string,revision:number){try{return await this.db.transaction(async tx=>{const initial=await this.peek(tx,id);if(!initial)return null;await this.authority(tx,initial.identity);const r=await this.fenced(tx,id,owner,revision);if(!r||r.state!=='reserved')return null;const envelope=decryptJson<{identityDigest:string;body:CopilotCreateBody}>(r.body_ciphertext,this.key);if(envelope.identityDigest!==digest(r.identity)||digest(envelope.body)!==r.identity.bodyDigest)fail();await tx.query("UPDATE naive_copilot.dispatches SET state='ambiguous',revision=revision+1 WHERE id=$1",[id]);return {record:record((await this.row(tx,id))!),body:envelope.body};});}catch{return fail();}}
 async attachSession(id:string,owner:string,revision:number,sessionId:string){if(!/^ses_[0-9a-hjkmnp-tv-z]{26}$/.test(sessionId))fail();return this.db.transaction(async tx=>{const r=await this.fenced(tx,id,owner,revision);if(!r||!['ambiguous','running'].includes(r.state))return null;if(r.session_id&&r.session_id!==sessionId)fail();await tx.query("UPDATE naive_copilot.dispatches SET state='running',session_id=$2,revision=revision+1 WHERE id=$1",[id,sessionId]);return record((await this.row(tx,id))!);});}
 async settle(id:string,owner:string,revision:number,measurement:{consumedMicroUsd:number;terminal:'completed'|'failed'}){if(!Number.isSafeInteger(measurement.consumedMicroUsd)||measurement.consumedMicroUsd<0||!['completed','failed'].includes(measurement.terminal))fail();return this.db.transaction(async tx=>{const initial=await this.peek(tx,id);if(!initial)return null;await lockJobBudget(tx,initial.identity.task.jobId);await tx.query('SELECT id FROM naive_internal.tasks WHERE id=$1 FOR UPDATE',[initial.identity.task.id]);const r=await this.fenced(tx,id,owner,revision);if(!r||!r.session_id||r.state!=='running')return null;const ledger=new SharedJobBudgetLedger(adapter(tx));const settled=await ledger.settle(r.identity.reservationId,measurement.consumedMicroUsd);if(settled.settledMicroUsd!==measurement.consumedMicroUsd)fail();const t=r.identity.task;await tx.query('INSERT INTO naive_copilot.cost_outbox(dispatch_id,job_id,customer_id,environment,session_id,consumed_micro_usd) VALUES($1,$2,$3,$4,$5,$6)',[id,t.jobId,t.customerId,t.environment,r.session_id,measurement.consumedMicroUsd]);await tx.query('UPDATE naive_copilot.dispatches SET state=$2,consumed_micro_usd=$3,revision=revision+1 WHERE id=$1',[id,measurement.terminal,measurement.consumedMicroUsd]);if(measurement.terminal==='failed')await tx.query('UPDATE naive_internal.tasks SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL',[t.id]);return record((await this.row(tx,id))!);});}
 async publication<T>(id:string,owner:string,revision:number,fn:(tx:AgentSqlExecutor,r:DispatchRecord)=>Promise<T>):Promise<T|null>{try{return await this.db.transaction(async tx=>{const initial=await this.peek(tx,id);if(!initial)return null;await this.authority(tx,initial.identity,true,true);const r=await this.fenced(tx,id,owner,revision);if(!r||r.state!=='completed')return null;const result=await fn(tx,record(r));await tx.query('UPDATE naive_internal.tasks SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL',[r.identity.task.id]);return result;});}catch{return fail();}}
 async revoke(id:string){return this.db.transaction(async tx=>{const initial=await this.peek(tx,id);if(!initial)return null;await tx.query('SELECT id FROM jobs WHERE id=$1 FOR UPDATE',[initial.identity.task.jobId]);await tx.query('UPDATE naive_internal.tasks SET revoked_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL',[initial.identity.task.id]);const r=await this.row(tx,id);if(!r)return null;if(r.state==='reserved')await tx.query("UPDATE naive_copilot.dispatches SET state='revoked',revision=revision+1 WHERE id=$1",[id]);return record((await this.row(tx,id))!);});}
}

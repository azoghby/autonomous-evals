import { createHash } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { lockJobBudget, reserveJobBudget, markJobBudgetDispatched, linkRunningJobBudgetCost, completeJobBudget, type JobBudgetTx } from '@ae/core/db/job-budget-authority';

export interface GatewayBudgetSql { transaction<T>(fn:(tx:JobBudgetTx)=>Promise<T>):Promise<T> }
export interface GatewayTurnIdentity { jobId:string; ownerId:string; messageId:string; requestDigest:string; allowanceMicroUsd:number; dailyCapMicroUsd:number }
export interface GatewayStepCost { microUsd:number; inputTokens:number; outputTokens:number; basis:string }
export interface GatewayTurnBudget { dispatched():Promise<void>; step(index:number,cost:GatewayStepCost):Promise<void>; complete():Promise<void> }
export const gatewayRequestDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=():never=>{throw Error('job_copilot_budget_unavailable');};
/** One retained server message identity admits at most one provider attempt. Unknown
 * dispatches and estimated usage retain their residual hold for reconciliation. */
export async function reserveGatewayTurn(sql:GatewayBudgetSql,input:GatewayTurnIdentity):Promise<GatewayTurnBudget>{
 const operationId=`gateway-copilot:${input.jobId}:${input.messageId}`;
 const canonical=async(tx:JobBudgetTx)=>{
  await lockJobBudget(tx,input.jobId);
  const j=(await tx.query<{customer_id:string;environment:string;package:string}>('SELECT customer_id,environment,package::text AS package FROM jobs WHERE id=$1 FOR UPDATE',[input.jobId])).rows[0];
  if(!j||j.customer_id!==input.ownerId||!['test','live'].includes(j.environment))return fail();return j;
 };
 if(!Number.isSafeInteger(input.allowanceMicroUsd)||input.allowanceMicroUsd<=0||!Number.isSafeInteger(input.dailyCapMicroUsd)||input.dailyCapMicroUsd<input.allowanceMicroUsd||!/^[a-f0-9]{64}$/.test(input.requestDigest))fail();
 await sql.transaction(async tx=>{
  const j=await canonical(tx);
  // Serialize this owner's allowance across different jobs as well. This mutex is
  // acquired only after the canonical job, consistently for all Gateway turns.
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`gateway-copilot-owner:${input.ownerId}`]);
  const old=(await tx.query('SELECT operation_id FROM job_budget.gateway_turns WHERE operation_id=$1',[operationId])).rows[0];if(old)return fail();
  const spent=(await tx.query<{total:string}>(`SELECT (COALESCE((SELECT SUM(c.micro_usd) FROM costs c WHERE c.agent='eval_copilot' AND c.created_at>=clock_timestamp()-interval '24 hours' AND c.meta->>'ownerId'=$1),0)+COALESCE((SELECT SUM(GREATEST(0,t.allowance_micro_usd-COALESCE((SELECT SUM(c.micro_usd) FROM job_budget.cost_links l JOIN costs c ON c.id=l.cost_id WHERE l.operation_id=t.operation_id),0))) FROM job_budget.gateway_turns t JOIN job_budget.operations o ON o.operation_id=t.operation_id WHERE t.owner_id=$1 AND o.completed_at IS NULL AND o.refunded_at IS NULL),0))::text AS total`,[input.ownerId])).rows[0];
  if(!spent||BigInt(spent.total)+BigInt(input.allowanceMicroUsd)>BigInt(input.dailyCapMicroUsd))return fail();
  const r=await reserveJobBudget(tx,{jobId:input.jobId,operationId,amountMicroUsd:input.allowanceMicroUsd});if(!r.ok)return fail();
  await tx.query('INSERT INTO job_budget.gateway_turns(operation_id,job_id,owner_id,environment,package,message_id,request_digest,allowance_micro_usd) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[operationId,input.jobId,input.ownerId,j.environment,j.package,input.messageId,input.requestDigest,input.allowanceMicroUsd]);
 });
 const retained=async(tx:JobBudgetTx)=>{
  const j=await canonical(tx);
  const t=(await tx.query<{environment:string;package:string;request_digest:string;dispatched_at:unknown;completed_at:unknown}>(`SELECT t.environment,t.package,t.request_digest,o.dispatched_at,o.completed_at FROM job_budget.gateway_turns t JOIN job_budget.operations o ON o.operation_id=t.operation_id WHERE t.operation_id=$1 AND t.owner_id=$2 FOR UPDATE OF t,o`,[operationId,input.ownerId])).rows[0];
  if(!t||t.environment!==j.environment||t.package!==j.package||t.request_digest!==input.requestDigest)return fail();return t;
 };
 return {
  dispatched:()=>sql.transaction(async tx=>{const t=await retained(tx);if(t.dispatched_at||t.completed_at)return fail();await markJobBudgetDispatched(tx,input.jobId,operationId);}),
  step:(index,cost)=>sql.transaction(async tx=>{
   const t=await retained(tx);if(!t.dispatched_at||t.completed_at||!Number.isSafeInteger(index)||index<0||index>=6||![cost.microUsd,cost.inputTokens,cost.outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0)||!['gateway_reported','list_price_estimate'].includes(cost.basis))return fail();
   const identity=JSON.stringify(cost);
   const old=(await tx.query<{identity:string}>('SELECT identity FROM job_budget.gateway_steps WHERE operation_id=$1 AND step_index=$2',[operationId,index])).rows[0];if(old){if(old.identity!==identity)return fail();return;}
   const receipt=`${operationId}:step:${index}`;
   const c=(await tx.query<{id:string}>(`INSERT INTO costs(job_id,source,agent,micro_usd,meta,receipt_key,receipt_identity) VALUES($1,'ai_gateway','eval_copilot',$2,$3::jsonb,$4,$5::jsonb) RETURNING id`,[input.jobId,cost.microUsd,JSON.stringify({ownerId:input.ownerId,evalKind:'job',evalId:input.jobId,inputTokens:cost.inputTokens,outputTokens:cost.outputTokens,costBasis:cost.basis,operationId,step:index}),receipt,JSON.stringify({operationId,index,cost,ownerId:input.ownerId,environment:t.environment,jobId:input.jobId})])).rows[0];if(!c)return fail();
   await tx.query('INSERT INTO job_budget.gateway_steps(operation_id,step_index,cost_id,identity,measured) VALUES($1,$2,$3,$4,$5)',[operationId,index,c.id,identity,cost.basis==='gateway_reported']);
   if(cost.basis==='gateway_reported')await linkRunningJobBudgetCost(tx,{jobId:input.jobId,operationId,costId:c.id});
  }),
  complete:()=>sql.transaction(async tx=>{const t=await retained(tx);if(!t.dispatched_at)return fail();const steps=(await tx.query<{measured:boolean}>('SELECT measured FROM job_budget.gateway_steps WHERE operation_id=$1 ORDER BY step_index',[operationId])).rows;if(!steps.length||steps.some(s=>!s.measured))return;await completeJobBudget(tx,input.jobId,operationId);}),
 };
}
let pool:Pool|undefined;
export function gatewayBudgetSql():GatewayBudgetSql{return {transaction:async fn=>{
 const connectionString=process.env.DATABASE_URL_UNPOOLED??process.env.DATABASE_URL;
 if(!connectionString)return fail();
 pool??=new Pool({connectionString,max:5});
 const client=await pool.connect();let discard=false,committing=false;
 try{
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  const result=await fn({query:async<T>(text:string,params?:unknown[])=>({rows:(await client.query(text,params)).rows as T[]})});
  committing=true;await client.query('COMMIT');return result;
 }catch(e){
  discard=committing;
  try{await client.query('ROLLBACK');}catch{discard=true;}
  throw e;
 }finally{client.release(discard);}
 }};}

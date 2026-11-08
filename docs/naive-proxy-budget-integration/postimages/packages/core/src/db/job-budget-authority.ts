import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { proxyBillingDigest } from '../judges/naive-proxy-reconcile';
import { JOB_BUDGET_MICRO_USD } from '../contracts/index';

/** Pinned READ COMMITTED transaction; rollback on exception, no automatic callback retry.
 * Lock order: canonical job -> Workflow advisory mutex -> operation -> model scopes.
 * Every spending writer must participate. Merely installing the table changes no authority. */
export interface JobBudgetTx { query<T = Record<string, unknown>>(text:string, params?:unknown[]):Promise<{rows:T[]}> }
const fail=():never=>{throw Error('job_budget_conflict');};
const amount=(n:number,min=0)=>{if(!Number.isSafeInteger(n)||n<min)fail();};
const key=(s:string)=>{if(typeof s!=='string'||!s.length||s.length>4096||/[\u0000\uD800-\uDFFF]/u.test(s))fail();};
type Operation={operation_id:string;job_id:string;amount_micro_usd:string|number;workflow_agent:string|null;workflow_reservation_id:string|null;agent_reservation_id:string|null;admitted:boolean;dispatched_at:unknown;refunded_at:unknown;cost_id:string|null;completed_at:unknown};
export async function lockJobBudget(tx:JobBudgetTx,jobId:string){
 key(jobId);
 const j=(await tx.query<{package:string}>('SELECT package::text AS package FROM jobs WHERE id=$1 FOR UPDATE',[jobId])).rows[0];
 if(!j||!Object.prototype.hasOwnProperty.call(JOB_BUDGET_MICRO_USD,j.package))return fail();
 await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[jobId]);
 return JOB_BUDGET_MICRO_USD[j.package as keyof typeof JOB_BUDGET_MICRO_USD]!;
}
/** Unproven costs/holds and parent-child overlap remain counted. Only retained exact
 * receipt links remove a settled model debit already represented by a costs row. */
export async function jobBudgetExposure(tx:JobBudgetTx,jobId:string){
 const capMicroUsd=await lockJobBudget(tx,jobId);
 const invalid=(await tx.query<{invalid:boolean}>(`SELECT
 EXISTS(SELECT 1 FROM costs WHERE job_id=$1 AND (micro_usd<0 OR micro_usd>9007199254740991))
 OR EXISTS(SELECT 1 FROM budget_reservations WHERE job_id=$1 AND (micro_usd<0 OR micro_usd>9007199254740991))
 OR EXISTS(SELECT 1 FROM agent_persistence.reservations WHERE job_id=$1::text AND
 (amount_micro_usd<0 OR amount_micro_usd>9007199254740991 OR settled_micro_usd<0 OR settled_micro_usd>9007199254740991)) AS invalid`,[jobId])).rows[0];
 if(!invalid||invalid.invalid)return fail();
 const r=(await tx.query<{committed:string}>(`SELECT (
 COALESCE((SELECT SUM(micro_usd) FROM costs WHERE job_id=$1),0)
 +COALESCE((SELECT SUM(micro_usd) FROM budget_reservations WHERE job_id=$1 AND released_at IS NULL),0)
 +COALESCE((SELECT SUM(COALESCE(r.settled_micro_usd,r.amount_micro_usd)) FROM agent_persistence.reservations r
 WHERE r.job_id=$1::text AND r.first_result->>'ok'='true' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.scopes) s WHERE s->>'key' LIKE 'expert-%') AND NOT EXISTS (
 SELECT 1 FROM job_budget.operations o JOIN costs c ON c.id=o.cost_id
 WHERE o.agent_reservation_id=r.id AND o.job_id=$1 AND c.job_id=$1
 AND r.settled_micro_usd IS NOT NULL AND c.micro_usd=r.settled_micro_usd)),0)
 +COALESCE((SELECT SUM(GREATEST(0,o.amount_micro_usd-COALESCE((SELECT SUM(c.micro_usd) FROM job_budget.cost_links l JOIN costs c ON c.id=l.cost_id WHERE l.operation_id=o.operation_id AND c.job_id=o.job_id),0))) FROM job_budget.operations o WHERE o.job_id=$1 AND o.admitted
 AND o.workflow_reservation_id IS NULL AND o.agent_reservation_id IS NULL AND o.refunded_at IS NULL AND o.cost_id IS NULL AND o.completed_at IS NULL),0)
 )::text AS committed`,[jobId])).rows[0];
 if(!r)return fail();
 const committed=BigInt(r.committed);if(committed<0n||committed>BigInt(Number.MAX_SAFE_INTEGER))fail();
 return {capMicroUsd,committedMicroUsd:Number(committed),remainingMicroUsd:Number(BigInt(capMicroUsd)>committed?BigInt(capMicroUsd)-committed:0n)};
}
export interface JobBudgetRequest {jobId:string;operationId:string;amountMicroUsd:number;workflowAgent?:string;agentReservationId?:string}
async function operation(tx:JobBudgetTx,id:string){return (await tx.query<Operation>('SELECT * FROM job_budget.operations WHERE operation_id=$1 FOR UPDATE',[id])).rows[0];}
export async function reserveJobBudget(tx:JobBudgetTx,input:JobBudgetRequest){
 const {jobId,operationId,amountMicroUsd,workflowAgent,agentReservationId}=input;
 key(operationId);amount(amountMicroUsd,1);if(workflowAgent!==undefined)key(workflowAgent);if(agentReservationId!==undefined)key(agentReservationId);
 if(workflowAgent&&agentReservationId)fail();
 const exposure=await jobBudgetExposure(tx,jobId);
 const old=await operation(tx,operationId);
 if(old){if(old.job_id!==jobId||Number(old.amount_micro_usd)!==amountMicroUsd||old.workflow_agent!==(workflowAgent??null)||old.agent_reservation_id!==(agentReservationId??null))fail();return {ok:old.admitted,reservationId:old.workflow_reservation_id??operationId,remainingMicroUsd:exposure.remainingMicroUsd,replayed:true};}
 // Linking an already admitted model hold adopts its debit rather than charging twice.
 let represented=false;
 if(agentReservationId){const r=(await tx.query<{job_id:string;amount_micro_usd:string;first_result:{ok:boolean}|null}>('SELECT job_id,amount_micro_usd,first_result FROM agent_persistence.reservations WHERE id=$1 FOR UPDATE',[agentReservationId])).rows[0];if(!r||r.job_id!==jobId||Number(r.amount_micro_usd)!==amountMicroUsd||!r.first_result?.ok)fail();represented=true;}
 const ok=represented?exposure.committedMicroUsd<=exposure.capMicroUsd:exposure.remainingMicroUsd>=amountMicroUsd;
 const reservationId=workflowAgent&&ok?randomUUID():null;
 if(reservationId){await tx.query('INSERT INTO budget_reservations(id,job_id,agent,micro_usd) VALUES($1,$2,$3,$4)',[reservationId,jobId,workflowAgent,amountMicroUsd]);await tx.query('UPDATE jobs SET budget_reserved_micro_usd=budget_reserved_micro_usd+$2 WHERE id=$1',[jobId,amountMicroUsd]);}
 await tx.query('INSERT INTO job_budget.operations(operation_id,job_id,amount_micro_usd,workflow_agent,workflow_reservation_id,agent_reservation_id,admitted) VALUES($1,$2,$3,$4,$5,$6,$7)',[operationId,jobId,amountMicroUsd,workflowAgent??null,reservationId,agentReservationId??null,ok]);
 return {ok,reservationId:reservationId??operationId,remainingMicroUsd:exposure.remainingMicroUsd,replayed:false};
}
export async function reserveWorkflowJobBudget(tx:JobBudgetTx,input:{jobId:string;agent:string;amountMicroUsd:number}){
 await lockJobBudget(tx,input.jobId);key(input.agent);amount(input.amountMicroUsd,1);
 const open=(await tx.query<{id:string;micro_usd:string|number}>('SELECT id,micro_usd FROM budget_reservations WHERE job_id=$1 AND agent=$2 AND released_at IS NULL ORDER BY id FOR UPDATE',[input.jobId,input.agent])).rows;
 if(open.length>1)fail();
 if(open[0]){if(Number(open[0].micro_usd)!==input.amountMicroUsd)fail();const e=await jobBudgetExposure(tx,input.jobId);return {ok:e.committedMicroUsd<=e.capMicroUsd,reservationId:open[0].id,remainingMicroUsd:e.remainingMicroUsd,replayed:true};}
 const operationId=`workflow:${randomUUID()}`;
 const result=await reserveJobBudget(tx,{jobId:input.jobId,operationId,amountMicroUsd:input.amountMicroUsd,workflowAgent:input.agent});
 if(result.ok)await markJobBudgetDispatched(tx,input.jobId,operationId);
 return {...result,operationId};
}
export async function releaseWorkflowJobBudget(tx:JobBudgetTx,jobId:string,reservationId:string){
 await lockJobBudget(tx,jobId);
 await tx.query(`WITH r AS (UPDATE budget_reservations SET released_at=clock_timestamp() WHERE job_id=$1 AND id=$2 AND released_at IS NULL RETURNING micro_usd)
 UPDATE jobs SET budget_reserved_micro_usd=GREATEST(0,budget_reserved_micro_usd-(SELECT SUM(micro_usd) FROM r)) WHERE id=$1 AND EXISTS(SELECT 1 FROM r)`,[jobId,reservationId]);
}
export async function markJobBudgetDispatched(tx:JobBudgetTx,jobId:string,operationId:string){
 await lockJobBudget(tx,jobId);const o=await operation(tx,operationId);if(!o||o.job_id!==jobId||!o.admitted||o.refunded_at)fail();
 await tx.query('UPDATE job_budget.operations SET dispatched_at=COALESCE(dispatched_at,clock_timestamp()) WHERE operation_id=$1',[operationId]);
}
/** Trusted caller invokes before any provider dispatch attempt. Unknown create/usage can
 * never use this transition. Refunding model-ledger links requires ledger reconciliation. */
export async function refundUndispatchedJobBudget(tx:JobBudgetTx,jobId:string,operationId:string){
 await lockJobBudget(tx,jobId);const o=await operation(tx,operationId);if(!o||o.job_id!==jobId||!o.admitted||o.dispatched_at||o.cost_id||o.agent_reservation_id)fail();
 if(o.workflow_reservation_id)await releaseWorkflowJobBudget(tx,jobId,o.workflow_reservation_id);
 await tx.query('UPDATE job_budget.operations SET refunded_at=COALESCE(refunded_at,clock_timestamp()) WHERE operation_id=$1',[operationId]);
}
const proxyCount=z.number().refine(n=>Number.isSafeInteger(n)&&n>=0);
const proxyHex=z.string().regex(/^[a-f0-9]{64}$/);
const proxyIntentV1=z.object({schemaVersion:z.literal('naive_proxy_intent.v1'),jobId:z.string().regex(/^[A-Za-z0-9_-]{1,96}$/),operationId:z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),model:z.string().min(1),inputDigest:proxyHex,requestDigest:proxyHex,maxOutputTokens:z.number().int().min(1).max(4096)}).strict();
const proxyIntent=z.discriminatedUnion('schemaVersion',[proxyIntentV1,proxyIntentV1.extend({schemaVersion:z.literal('naive_proxy_intent.v2'),attempt:z.number().int().min(1).max(2147483647),checkpointId:proxyHex,reservationId:z.string()}).strict()]);
const proxyRequest=z.string().regex(/^req_[0-9a-hjkmnp-tv-z]{26}$/);
const proxyReceived=z.object({requestId:proxyRequest,usage:z.object({input:proxyCount,output:proxyCount,cache_read:proxyCount,cache_write:proxyCount}).strict().nullable()}).strict();
const proxyReceipt=z.object({source:z.literal('naive_proxy'),jobId:proxyIntentV1.shape.jobId,operationId:proxyIntentV1.shape.operationId,model:z.string().min(1),requestId:proxyRequest,microUsd:proxyCount,measured:z.literal(true),idempotencyKey:z.string()}).strict();
/** Resolve only the retained owner reconciliation chain. Amount and public cost metadata
 * cannot establish identity. Missing historical checkpoints remain additive. */
export async function retainedProxyReservation(tx:JobBudgetTx,jobId:string,receiptKey:string,expectedCostId?:string):Promise<string|null>{
 if(!/^naive_proxy:req_[0-9a-hjkmnp-tv-z]{26}$/.test(receiptKey))return null;
 const installed=(await tx.query<{present:unknown}>("SELECT to_regclass('text_integration.checkpoints') AS present")).rows[0];
 if(!installed?.present)return null;
 const bills=(await tx.query<{id:string;input_digest:string;value:unknown}>(`SELECT id,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND kind='naive_proxy_billing' AND state='completed' AND (value->>'requestId'=$2 OR value->>'idempotencyKey'=$3)`,[jobId,receiptKey.slice('naive_proxy:'.length),receiptKey])).rows;
 if(!bills.length)return null;
 if(bills.length!==1)fail();
 const bill=bills[0]!;const parsedReceipt=proxyReceipt.safeParse(bill.value);if(!parsedReceipt.success)return fail();const receipt=parsedReceipt.data;
 if(receipt.jobId!==jobId||receipt.idempotencyKey!==receiptKey||receiptKey!==`naive_proxy:${receipt.requestId}`)fail();
 const rows=(await tx.query<{kind:string;input_digest:string;value:unknown}>(`SELECT kind,input_digest,value FROM text_integration.checkpoints WHERE job_id=$1 AND id=$2 AND kind IN ('naive_proxy_intent','naive_proxy_received') AND state='completed'`,[jobId,bill.id])).rows;
 if(rows.length!==2)return fail();
 const intentRow=rows.find(r=>r.kind==='naive_proxy_intent'),receivedRow=rows.find(r=>r.kind==='naive_proxy_received');
 if(!intentRow||!receivedRow||intentRow.input_digest!==bill.input_digest||receivedRow.input_digest!==bill.input_digest)return fail();
 const parsedIntent=proxyIntent.safeParse(intentRow.value),received=proxyReceived.safeParse(receivedRow.value);
 if(!parsedIntent.success||!received.success)return fail();const intent=parsedIntent.data;
 const id=proxyBillingDigest({jobId,operationId:intent.operationId,...(intent.schemaVersion==='naive_proxy_intent.v2'?{attempt:intent.attempt}:{})});
 const reservationId=`naive-proxy:${id}`;
 if(intent.jobId!==jobId||intent.inputDigest!==bill.input_digest||bill.id!==id||intent.operationId!==receipt.operationId||intent.model!==receipt.model||received.data.requestId!==receipt.requestId)return fail();
 if(intent.schemaVersion==='naive_proxy_intent.v2'){
  if(intent.checkpointId!==id||intent.reservationId!==reservationId)return fail();
  const attempts=(await tx.query<{present:unknown}>("SELECT to_regclass('naive_proxy_dispatch.attempts') AS present")).rows[0];
  if(!attempts?.present)return fail();
  const retained=(await tx.query(`SELECT 1 FROM naive_proxy_dispatch.attempts a JOIN naive_proxy_dispatch.operations o USING(job_id,operation_id) WHERE a.job_id=$1 AND a.operation_id=$2 AND a.attempt=$3 AND a.checkpoint_id=$4 AND a.reservation_id=$5 AND a.state='dispatched' AND a.reserved AND o.input_digest=$6`,[jobId,intent.operationId,intent.attempt,id,reservationId,intent.inputDigest])).rows;
  if(retained.length!==1)return fail();
 }
 const cost=(await tx.query<{id:string;micro_usd:string|number;agent:string|null;session_id:string|null;meta:unknown;receipt_identity:unknown}>("SELECT id,micro_usd,agent,session_id,meta,receipt_identity FROM costs WHERE job_id=$1 AND source='naive_proxy' AND receipt_key=$2",[jobId,receiptKey])).rows;
 if(cost.length!==1||(expectedCostId!==undefined&&cost[0]!.id!==expectedCostId)||BigInt(cost[0]!.micro_usd)!==BigInt(receipt.microUsd)||cost[0]!.agent!=='judge'||cost[0]!.session_id!==null)return fail();
 const c=cost[0]!,meta=c.meta as Record<string,unknown>|null,identity=c.receipt_identity as Record<string,unknown>|null;
 if(!meta||meta.purpose!==intent.operationId||meta.operationId!==intent.operationId||meta.kind!=='rubric_judge'||meta.model!==intent.model||meta.measured!==true||meta.idempotencyKey!==receiptKey||!identity||identity.source!=='naive_proxy'||identity.agent!=='judge'||identity.sessionId!==null||identity.requestId!==receipt.requestId||identity.microUsd!==receipt.microUsd||proxyBillingDigest(identity.meta)!==proxyBillingDigest(meta))return fail();
 const scope=identity.scope as Record<string,unknown>|null;
 if(!scope||scope.kind!=='job'||scope.id!==jobId)return fail();
 return reservationId;
}

/** Receipt identity must already be validated by settleCost in this SAME transaction.
 * Exact retained model settlement + cost row is necessary; no metadata-based guessing. */
export async function linkJobBudgetCost(tx:JobBudgetTx,input:{jobId:string;operationId:string;costId:string;expectedReceiptKey:string}){
 await lockJobBudget(tx,input.jobId);const o=await operation(tx,input.operationId);if(!o||o.job_id!==input.jobId||!o.admitted||o.refunded_at||!o.dispatched_at||o.workflow_reservation_id||(o.cost_id&&o.cost_id!==input.costId))fail();
 const c=(await tx.query<{micro_usd:string|number;receipt_key:string|null;source:string}>('SELECT micro_usd,receipt_key,source FROM costs WHERE id=$1 AND job_id=$2 FOR UPDATE',[input.costId,input.jobId])).rows[0];if(!c||!c.receipt_key||c.receipt_key!==input.expectedReceiptKey||!/^(?:naive:ses_|naive_proxy:req_)[0-9a-hjkmnp-tv-z]{26}$/.test(c.receipt_key))fail();
 const isProxy=c!.receipt_key!.startsWith('naive_proxy:');
 if(c!.source!==(isProxy?'naive_proxy':'naive'))return fail();
 const sessionId=c!.receipt_key!.slice('naive:'.length);
 let bound=isProxy&&o.agent_reservation_id!==null&&(await retainedProxyReservation(tx,input.jobId,c!.receipt_key!,input.costId))===o.agent_reservation_id;
 if(o.agent_reservation_id&&!isProxy){
 const tasks=(await tx.query<{present:string|null}>("SELECT to_regclass('agent_persistence.tasks')::text AS present")).rows[0];
 if(tasks?.present)bound=(await tx.query("SELECT task_key FROM agent_persistence.tasks WHERE record->>'reservationId'=$1 AND record->>'sessionId'=$2 AND record->>'jobId'=$3 LIMIT 1",[o.agent_reservation_id,sessionId,input.jobId])).rows.length===1;
 const copilot=(await tx.query<{present:string|null}>("SELECT to_regclass('naive_copilot.dispatches')::text AS present")).rows[0];
 if(!bound&&copilot?.present)bound=(await tx.query("SELECT id FROM naive_copilot.dispatches WHERE identity->>'reservationId'=$1 AND session_id=$2 AND identity->'task'->>'jobId'=$3 LIMIT 1",[o.agent_reservation_id,sessionId,input.jobId])).rows.length===1;
 }
 if(!bound||(await tx.query('SELECT cost_id FROM job_budget.cost_links WHERE cost_id=$1',[input.costId])).rows.length)fail();
 if(o.agent_reservation_id){const r=(await tx.query<{settled_micro_usd:string|number|null}>('SELECT settled_micro_usd FROM agent_persistence.reservations WHERE id=$1 AND job_id=$2 FOR UPDATE',[o.agent_reservation_id,input.jobId])).rows[0];if(!r||r.settled_micro_usd===null||BigInt(r.settled_micro_usd)!==BigInt(c.micro_usd))fail();}
 await tx.query('UPDATE job_budget.operations SET cost_id=$2 WHERE operation_id=$1',[input.operationId,input.costId]);
}

/** The callback MUST reserve through the model ledger bound to this exact transaction.
 * No provider work occurs here. Failed callback/authority adoption rolls back everything. */
export async function admitModelReservationInTransaction<T extends {ok:boolean}>(tx:JobBudgetTx, input:{jobId:string;reservationId:string;amountMicroUsd:number;requestDigest:string}, reserve:()=>Promise<T>):Promise<T|{ok:false;remainingMicroUsd:number}> {
 amount(input.amountMicroUsd,1);key(input.reservationId);key(input.requestDigest);
 const e=await jobBudgetExposure(tx,input.jobId);
 const decision=(await tx.query<{job_id:string;amount_micro_usd:string|number;request_digest:string;admitted:boolean;remaining_micro_usd:string|number}>('SELECT * FROM job_budget.model_admissions WHERE reservation_id=$1 FOR UPDATE',[input.reservationId])).rows[0];
 if(decision&&(decision.job_id!==input.jobId||Number(decision.amount_micro_usd)!==input.amountMicroUsd||decision.request_digest!==input.requestDigest))fail();
 if(decision&&!decision.admitted)return {ok:false,remainingMicroUsd:Number(decision.remaining_micro_usd)};
 const existing=(await tx.query<{job_id:string;amount_micro_usd:string|number;first_result:{ok:boolean}|null}>('SELECT job_id,amount_micro_usd,first_result FROM agent_persistence.reservations WHERE id=$1 FOR UPDATE',[input.reservationId])).rows[0];
 if(existing&&(existing.job_id!==input.jobId||Number(existing.amount_micro_usd)!==input.amountMicroUsd))fail();
 if(!decision&&!existing?.first_result&&e.remainingMicroUsd<input.amountMicroUsd){
 await tx.query('INSERT INTO job_budget.model_admissions(reservation_id,job_id,amount_micro_usd,request_digest,admitted,remaining_micro_usd) VALUES($1,$2,$3,$4,false,$5)',[input.reservationId,input.jobId,input.amountMicroUsd,input.requestDigest,e.remainingMicroUsd]);
 return {ok:false,remainingMicroUsd:e.remainingMicroUsd};
 }
 const result=await reserve();
 if(!decision&&result.ok)await tx.query('INSERT INTO job_budget.model_admissions(reservation_id,job_id,amount_micro_usd,request_digest,admitted,remaining_micro_usd) VALUES($1,$2,$3,$4,$5,$6)',[input.reservationId,input.jobId,input.amountMicroUsd,input.requestDigest,result.ok,e.remainingMicroUsd]);
 if(result.ok){const admitted=await reserveJobBudget(tx,{jobId:input.jobId,operationId:`model:${input.reservationId}`,amountMicroUsd:input.amountMicroUsd,agentReservationId:input.reservationId});if(!admitted.ok)fail();}
 return result;
}

/** Cost identity is retained by the caller's measured cost sink in this transaction.
 * Each cost can cover one operation only; unrelated legacy costs remain additive. */
export async function linkRunningJobBudgetCost(tx:JobBudgetTx,input:{jobId:string;operationId:string;costId:string}){
 await lockJobBudget(tx,input.jobId);const o=await operation(tx,input.operationId);
 if(!o||o.job_id!==input.jobId||!o.admitted||!o.dispatched_at||o.refunded_at||o.completed_at||o.agent_reservation_id||o.workflow_reservation_id)fail();
 const c=(await tx.query<{id:string}>('SELECT id FROM costs WHERE id=$1 AND job_id=$2 FOR UPDATE',[input.costId,input.jobId])).rows[0];if(!c)fail();
 await tx.query('INSERT INTO job_budget.cost_links(operation_id,cost_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[input.operationId,input.costId]);
 const retained=(await tx.query<{operation_id:string}>('SELECT operation_id FROM job_budget.cost_links WHERE cost_id=$1',[input.costId])).rows[0];if(retained?.operation_id!==input.operationId)fail();
}
/** Trusted known terminal only, after all measured step costs were inserted and linked.
 * An abort, lost response, or unknown final usage must retain the pending hold. */
export async function completeJobBudget(tx:JobBudgetTx,jobId:string,operationId:string){
 await lockJobBudget(tx,jobId);const o=await operation(tx,operationId);
 if(!o||o.job_id!==jobId||!o.admitted||!o.dispatched_at||o.refunded_at||o.agent_reservation_id||o.workflow_reservation_id)fail();
 await tx.query('UPDATE job_budget.operations SET completed_at=COALESCE(completed_at,clock_timestamp()) WHERE operation_id=$1',[operationId]);
}

/** Trusted accounting capability. No publication authority, prompts or paid dispatch API. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { VettaClient } from '@usenaive-sdk/managed-agents';
import type { TextCheckpointStore, CheckpointKey } from '../evals/integration/checkpoints';
import { canonicalJson } from '../evals/text/freeze';
import type { NaiveProxyBudgetPort, NaiveProxyCost } from './naive-proxy';

export const proxyBillingDigest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().refine(v => Number.isSafeInteger(v) && v >= 0);
const Usage = z.object({input:count,output:count,cache_read:count,cache_write:count}).strict();
const IntentV1 = z.object({schemaVersion:z.literal('naive_proxy_intent.v1'),jobId:z.string().regex(/^[A-Za-z0-9_-]{1,96}$/),operationId:z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),model:z.string().min(1),inputDigest:hex,requestDigest:hex,maxOutputTokens:z.number().int().min(1).max(4096)}).strict();
const IntentV2=IntentV1.extend({schemaVersion:z.literal('naive_proxy_intent.v2'),attempt:z.number().int().min(1).max(2147483647),checkpointId:hex,reservationId:z.string()}).strict();
const Intent=z.discriminatedUnion('schemaVersion',[IntentV1,IntentV2]);
export type NaiveProxyBillingIntent = z.infer<typeof Intent>;
const Received = z.object({requestId:z.string().regex(/^req_[0-9a-hjkmnp-tv-z]{26}$/),usage:Usage.nullable()}).strict();
const Receipt = z.object({source:z.literal('naive_proxy'),jobId:IntentV1.shape.jobId,operationId:IntentV1.shape.operationId,model:z.string().min(1),requestId:Received.shape.requestId,microUsd:count,measured:z.literal(true),idempotencyKey:z.string()}).strict();
const unavailable = (): never => { throw new Error('Naive proxy billing reconciliation unavailable; retain the existing operation.'); };
export interface NaiveProxyReconcileDeps {
 checkpoints: TextCheckpointStore;
 /** Supply audit:read only; this capability never creates a provider request. */
 proxy: Pick<VettaClient['proxy'],'call'>;
 budget: Pick<NaiveProxyBudgetPort,'settle'>;
 /** Adopted atomic keyed owner sink, independently available after evaluation revocation. */
 recordCost(receipt:NaiveProxyCost):Promise<void>;
}
/** Requires a trusted owner-selected job/operation. Never expose this as a customer route.
 * Missing provider identity is ambiguous and stays fenced; this function never repairs it by dispatch. */
export async function reconcileNaiveProxyBilling(lookup:{jobId:string;operationId:string;attempt?:number},deps:NaiveProxyReconcileDeps):Promise<NaiveProxyCost> {
 if(!/^[A-Za-z0-9_-]{1,96}$/.test(lookup.jobId)||!/^[A-Za-z0-9_.:-]{1,200}$/.test(lookup.operationId))return unavailable();
 if(lookup.attempt!==undefined&&(!Number.isSafeInteger(lookup.attempt)||lookup.attempt<1||lookup.attempt>2147483647))return unavailable();
 const id=proxyBillingDigest({jobId:lookup.jobId,operationId:lookup.operationId,...(lookup.attempt===undefined?{}:{attempt:lookup.attempt})});
 const stored=await deps.checkpoints.get({jobId:lookup.jobId,kind:'naive_proxy_intent',id});
 if(stored?.state!=='completed')return unavailable();
 const parsed=Intent.safeParse(stored.value);if(!parsed.success)return unavailable();const intent=parsed.data;
 if(intent.jobId!==lookup.jobId||intent.operationId!==lookup.operationId)return unavailable();
 if(lookup.attempt===undefined?intent.schemaVersion!=='naive_proxy_intent.v1':intent.schemaVersion!=='naive_proxy_intent.v2'||intent.attempt!==lookup.attempt||intent.checkpointId!==id||intent.reservationId!==`naive-proxy:${id}`)return unavailable();
 const key:CheckpointKey={jobId:lookup.jobId,kind:'naive_proxy_intent',id,inputDigest:intent.inputDigest};
 // Re-read with digest: the SQL store validates its immutable row identity as well as JSON content.
 await deps.checkpoints.get(key);
 const receivedRow=await deps.checkpoints.get({...key,kind:'naive_proxy_received'});
 if(receivedRow?.state!=='completed')return unavailable();
 const receivedParsed=Received.safeParse(receivedRow.value);if(!receivedParsed.success)return unavailable();const received=receivedParsed.data;
 const billingKey={...key,kind:'naive_proxy_billing'};
 const retained=await deps.checkpoints.get(billingKey);
 let receipt:NaiveProxyCost;
 if(retained?.state==='completed'){const parsedReceipt=Receipt.safeParse(retained.value);if(!parsedReceipt.success)return unavailable();receipt=parsedReceipt.data;}
 else {
  if(retained)return unavailable();
  const trace=await deps.proxy.call(received.requestId);
  if(trace.id!==received.requestId||trace.source!=='proxy'||trace.session_id!==null||trace.dialect!=='anthropic'||trace.model!==intent.model||trace.window!=='immediate'||!count.safeParse(trace.billed_micro_usd).success
   ||!trace.usage||!Usage.safeParse({input:trace.usage.input,output:trace.usage.output,cache_read:trace.usage.cache_read,cache_write:trace.usage.cache_write}).success
   ||received.usage!==null&&Object.entries(received.usage).some(([k,v])=>trace.usage[k as 'input'|'output'|'cache_read'|'cache_write']!==v)
   ||trace.content_scope!=='full'||trace.truncated||!trace.request||trace.request.model!==intent.model||trace.request.max_output_tokens!==intent.maxOutputTokens
   ||proxyBillingDigest({model:trace.request.model,system:trace.request.system,max_output_tokens:trace.request.max_output_tokens,messages:trace.request.messages})!==intent.requestDigest)return unavailable();
  const main=await deps.checkpoints.get({...key,kind:'naive_proxy_judge'});
  if(main?.state==='completed'){
   const value=main.value as {usable?:unknown;text?:unknown};
   if(value.usable===true&&(trace.stop!=='end_turn'||!trace.response||trace.response.text!==value.text||trace.response.is_error||trace.response.partial||trace.response.tool_calls.length!==0))return unavailable();
  }
  receipt={source:'naive_proxy',jobId:intent.jobId,operationId:intent.operationId,model:intent.model,requestId:received.requestId,microUsd:trace.billed_micro_usd!,measured:true,idempotencyKey:`naive_proxy:${received.requestId}`};
  const claim=await deps.checkpoints.claim(billingKey);
  if(claim.state==='claimed')await deps.checkpoints.complete(billingKey,claim.token,receipt);
  else if(claim.state!=='completed'||canonicalJson(claim.value)!==canonicalJson(receipt))return unavailable();
 }
 if(!receipt||receipt.source!=='naive_proxy'||receipt.jobId!==intent.jobId||receipt.operationId!==intent.operationId||receipt.model!==intent.model||receipt.requestId!==received.requestId||receipt.measured!==true||receipt.idempotencyKey!==`naive_proxy:${received.requestId}`||!count.safeParse(receipt.microUsd).success)return unavailable();
 await deps.budget.settle({reservationId:`naive-proxy:${id}`,receipt:structuredClone(receipt),...(lookup.attempt===undefined?{}:{attempt:lookup.attempt})});
 await deps.recordCost(structuredClone(receipt));
 return structuredClone(receipt);
}

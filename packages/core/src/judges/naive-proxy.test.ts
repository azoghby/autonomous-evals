import { createHash } from 'node:crypto';
import { canonicalJson } from '../evals/text/freeze';
import { describe, expect, it, vi } from 'vitest';
import type { VettaClient } from '@usenaive-sdk/managed-agents';
import type { TextCheckpointStore, CheckpointValue } from '../evals/integration/checkpoints';
import { createNaiveProxyJudge, type NaiveProxyCost } from './naive-proxy';
import { createNaiveProxyBudget } from './naive-proxy-budget';
function fixture() {
  const rows = new Map<string,{digest:string;value:CheckpointValue}>();
  const store: TextCheckpointStore = {
    async claim(k){const r=rows.get(k.kind+':'+k.id);if(r){if(r.digest!==k.inputDigest)throw Error('identity');return structuredClone(r.value);}rows.set(k.kind+':'+k.id,{digest:k.inputDigest,value:{state:'pending'}});return {state:'claimed',token:'t'};},
    async get(k){const r=rows.get(k.kind+':'+k.id);if(r&&k.inputDigest&&r.digest!==k.inputDigest)throw Error('identity');return r?structuredClone(r.value):null;},
    async complete(k,_t,value){rows.set(k.kind+':'+k.id,{digest:k.inputDigest,value:{state:'completed',value:structuredClone(value)}});},
    async markAmbiguous(k){rows.set(k.kind+':'+k.id,{digest:k.inputDigest,value:{state:'ambiguous'}});},async release(){throw Error('no release');},
  };
  const input={operationId:'judge-1',rubric:'Be polite',response:'Please continue'};
  let secrets:string[]=[];
  const text=JSON.stringify({outcome:'rubric_concern',explanation:'Tone concern',evidenceQuotes:['Please']});
  const id='req_'+'a'.repeat(26);
  const response={id,model:'test-model',content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:0,cache_creation_input_tokens:0}};
  let body:any;
  const messages=vi.fn(async(b:unknown)=>{body=b;return response;});
  const call=vi.fn(async()=>({id,source:'proxy',session_id:null as string|null,dialect:'anthropic',model:'test-model',window:'immediate',billed_micro_usd:17,vendor_cost_micro_usd:9999,content_scope:'full',truncated:false,
    usage:{input:10,output:5,cache_read:0,cache_write:0,reasoning:0},stop:'end_turn',response:{text:response.content[0].text,tool_calls:[]},request:{model:body.model,system:body.system,max_output_tokens:body.max_tokens,messages:body.messages}}));
  const reserve=vi.fn(async()=>true),settle=vi.fn(async()=>{}),recordCost=vi.fn(async(_c:NaiveProxyCost)=>{}),authorize=vi.fn(async()=>({knownSecrets:secrets}));
  const judge=createNaiveProxyJudge({jobId:'job',model:'test-model',maxOutputTokens:1000,reservationMicroUsd:300000,checkpoints:store,budget:{reserve,settle},authorize,recordCost,client:()=>({proxy:{messages,call}} as unknown as Pick<VettaClient,'proxy'>)});
  return {judge,input,messages,call,reserve,settle,recordCost,authorize,response,setSecrets:(v:string[])=>{secrets=v;}};
}
describe('Naive proxy Jude',()=>{
 it('reconciles billed price (not vendor cost), settles and replays the same receipt without dispatch',async()=>{
  const f=fixture();expect((await f.judge(f.input)).outcome).toBe('rubric_concern');await f.judge(f.input);
  expect(f.messages).toHaveBeenCalledTimes(1);expect(f.call).toHaveBeenCalledTimes(1);expect(f.recordCost).toHaveBeenCalledTimes(2);
  expect(f.recordCost.mock.calls[0][0]).toMatchObject({source:'naive_proxy',microUsd:17,measured:true,idempotencyKey:'naive_proxy:req_'+'a'.repeat(26)});
 });
 it('holds unknown billing and reconciles later without another paid call',async()=>{
  const f=fixture(),original=f.call.getMockImplementation()!;f.call.mockImplementationOnce(async()=>({...await original(),billed_micro_usd:null}) as never);
  await expect(f.judge(f.input)).rejects.toThrow('unavailable');expect(f.settle).not.toHaveBeenCalled();await f.judge(f.input);expect(f.messages).toHaveBeenCalledTimes(1);
 });
 it('permanently fences ambiguous dispatch rather than retry a new call',async()=>{
  const f=fixture();f.messages.mockRejectedValueOnce(Error('timeout SECRET'));await expect(f.judge(f.input)).rejects.toThrow('unavailable');await expect(f.judge(f.input)).rejects.toThrow('unavailable');expect(f.messages).toHaveBeenCalledTimes(1);expect(f.settle).not.toHaveBeenCalled();
 });
 it('records measured cost even when judgment has fabricated quotes',async()=>{
  const f=fixture();f.response.content[0].text=JSON.stringify({outcome:'rubric_concern',explanation:'bad',evidenceQuotes:['fabricated']});
  await expect(f.judge(f.input)).rejects.toThrow('unavailable');expect(f.recordCost).toHaveBeenCalledTimes(1);
 });
 it('recovers lost sink acknowledgement without redispatch',async()=>{
  const f=fixture();f.recordCost.mockRejectedValueOnce(Error('ack lost'));await expect(f.judge(f.input)).rejects.toThrow('ack lost');await f.judge(f.input);expect(f.messages).toHaveBeenCalledTimes(1);expect(f.recordCost.mock.calls[0]).toEqual(f.recordCost.mock.calls[1]);
 });
 it('refuses changed input and revoked current authorization on completed replay',async()=>{
  const f=fixture();await f.judge(f.input);await expect(f.judge({...f.input,rubric:'changed'})).rejects.toThrow();f.authorize.mockRejectedValueOnce(Error('revoked'));await expect(f.judge(f.input)).rejects.toThrow('revoked');expect(f.messages).toHaveBeenCalledTimes(1);
 });
 it('returns factual inconclusive without a paid call if reference is missing',async()=>{
  const f=fixture();expect((await f.judge({...f.input,assessesFactualCorrectness:true})).outcome).toBe('inconclusive');expect(f.messages).not.toHaveBeenCalled();expect(f.reserve).not.toHaveBeenCalled();
 });
 it('denies dispatch when reservation is refused',async()=>{const f=fixture();f.reserve.mockResolvedValue(false);await expect(f.judge(f.input)).rejects.toThrow('unavailable');expect(f.messages).not.toHaveBeenCalled();});
 it('refuses unrelated or mismatched provider accounting',async()=>{
  const f=fixture(),original=f.call.getMockImplementation()!;f.call.mockImplementationOnce(async()=>({...await original(),session_id:'ses_other'}));await expect(f.judge(f.input)).rejects.toThrow('unavailable');expect(f.settle).not.toHaveBeenCalled();
 });
 it('screens rotated output secrets before returning a paid verdict',async()=>{
  const f=fixture();f.recordCost.mockImplementationOnce(async()=>{f.setSecrets(['Tone concern']);});await expect(f.judge(f.input)).rejects.toThrow('unavailable');expect(f.recordCost).toHaveBeenCalledTimes(1);
 });
 it('preserves a measured zero rather than treating it as absent',async()=>{
  const f=fixture(),original=f.call.getMockImplementation()!;f.call.mockImplementationOnce(async()=>({...await original(),billed_micro_usd:0}));await f.judge(f.input);expect(f.recordCost.mock.calls[0][0].microUsd).toBe(0);
 });
});
describe('Naive proxy shared ledger adapter',()=>{
 it('reserves both job and Jude scopes and rejects conflicting settlement',async()=>{
  const reserve=vi.fn(async()=>({ok:true as const,reservationId:'r',replayed:false})),settle=vi.fn(async()=>({settledMicroUsd:7,replayed:true}));
  const budget=createNaiveProxyBudget({reserve,settle},{jobId:'job',period:'2026-11',jobCapMicroUsd:100,judgeCapMicroUsd:200});
  const reservationId=`naive-proxy:${createHash('sha256').update(canonicalJson({jobId:'job',operationId:'op'})).digest('hex')}`;
  expect(await budget.reserve({reservationId,jobId:'job',operationId:'op',inputDigest:'a'.repeat(64),amountMicroUsd:50})).toBe(true);
  expect(reserve.mock.calls[0]).toMatchObject([{scopes:[{key:'job:job',capMicroUsd:100},{key:'agent:judge:2026-11',capMicroUsd:200}]}]);
  await expect(budget.reserve({reservationId:'unrelated',jobId:'job',operationId:'op',inputDigest:'a'.repeat(64),amountMicroUsd:50})).rejects.toThrow('unavailable');expect(reserve).toHaveBeenCalledTimes(1);
  await expect(budget.settle({reservationId:'unrelated',receipt:{source:'naive_proxy',jobId:'job',operationId:'op',model:'m',requestId:'req_'+'a'.repeat(26),microUsd:8,measured:true,idempotencyKey:'naive_proxy:req_'+'a'.repeat(26)}})).rejects.toThrow('unavailable');expect(settle).not.toHaveBeenCalled();
  await expect(budget.settle({reservationId,receipt:{source:'naive_proxy',jobId:'job',operationId:'op',model:'m',requestId:'req_'+'a'.repeat(26),microUsd:8,measured:true,idempotencyKey:'naive_proxy:req_'+'a'.repeat(26)}})).rejects.toThrow('unavailable');
 });
});

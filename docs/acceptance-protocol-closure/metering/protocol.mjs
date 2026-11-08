import { dirname } from 'node:path';
import { mkdirSync, rmdirSync, openSync, closeSync, fsyncSync, writeSync, readFileSync } from 'node:fs';

// Offline protocol artifact. Neither module imports application/configuration code.
export const APPROVED_CAPS = Object.freeze({target:32,gateway:16,naive:0,cloudMutation:0,maxElapsedMs:180000});
export const FULL_OPERATION_PLAN = Object.freeze({target:77,gateway:50,naive:10,cloudMutation:0,maxElapsedMs:180000});
export const PLAN_ROWS = Object.freeze([
  {operation:'Text baseline frozen12',target:12,gateway:24,naive:0},
  {operation:'One investigator task and Text reproduction',target:1,gateway:2,naive:2},
  {operation:'One engineer proposal task',target:0,gateway:0,naive:2},
  {operation:'Text trial frozen12',target:12,gateway:24,naive:0},
  {operation:'Calendar baseline12 and trial12',target:48,gateway:0,naive:0},
  {operation:'Two Calendar SQL reproductions',target:4,gateway:0,naive:0},
  {operation:'Three operator report tasks',target:0,gateway:0,naive:6},
].map(Object.freeze));
const keys=Object.keys(APPROVED_CAPS), kinds=keys.filter(k=>k!=='maxElapsedMs');
const observationAdvance=(a,b)=>a.operationId===b.operationId&&a.providerReceiptId===b.providerReceiptId&&['actualCostMicroUsd','inputTokens','outputTokens'].every(k=>a[k]===b[k]||(a[k]===null&&b[k]!==null))&&JSON.stringify(a)!==JSON.stringify(b);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
function exactLimits(limits) {
  if (!limits || keys.some(k=>limits[k]!==APPROVED_CAPS[k])) throw Error('approved_caps_changed');
}
export function planDeficits() { return Object.fromEntries(kinds.map(k=>[k,Math.max(0,FULL_OPERATION_PLAN[k]-APPROVED_CAPS[k])])); }
export function assertFullPlan(limits) {
  exactLimits(limits);
  for(const k of keys) if(FULL_OPERATION_PLAN[k]>limits[k]) throw Error(`operation_plan_exceeds_approved_caps:${k}:${FULL_OPERATION_PLAN[k]}`);
}
export async function createAcceptanceDriver(options) {
  assertFullPlan(options.limits); // Intentionally before reading ANY private runtime.
  throw Error('owner_composition_and_hosted_authorization_required');
}
export function costEnvelope({contextBound, judgeReservation, remediationReservation}) {
  if (![contextBound,judgeReservation,remediationReservation].every(v=>integer(v)&&v>0)) throw Error('invalid_cost_bounds');
  const knownReservationMicroUsd=900000+2*contextBound+50*judgeReservation+12*remediationReservation;
  if(!integer(knownReservationMicroUsd)) throw Error('invalid_cost_bounds');
  return {knownReservationMicroUsd,completeMaximumMicroUsd:null,unknown:['baseline/reproduction Text target pricing','Calendar target pricing','input token bounds/provider prices','additional polling/retries/recovery'],requestedCompletionTokens:{text:25*512,gateway:50*2048},monetaryAuthorization:false};
}

/** Trusted local fsync journal only: not a provider receipt verifier or hosted store.
 * Every operation, including retries/polls, reserves its own unique attempt before dispatch.
 * Observation retries are idempotent; dispatch retries never are. Unknown cost retains hold.
 */
export function createObservationMeter(path,{limits=APPROVED_CAPS,maxReservedMicroUsd,now=Date.now}={}) {
  exactLimits(limits);
  if(!integer(maxReservedMicroUsd)) throw Error('invalid_monetary_cap');
  const authority={limits:{...APPROVED_CAPS},maxReservedMicroUsd};
  const lock=path+'.lock';
  const locked=fn=>{mkdirSync(lock);try{return fn();}finally{rmdirSync(lock);}};
  function append(row) {const fd=openSync(path,'a',0o600);try{const b=Buffer.from(JSON.stringify(row)+'\n');let n=0;while(n<b.length)n+=writeSync(fd,b,n,b.length-n);fsyncSync(fd);}finally{closeSync(fd);}}
  function read() {
    const raw=readFileSync(path,'utf8');if(!raw.endsWith('\n'))throw Error('ambiguous_meter_log');
    const [header,...rows]=raw.trimEnd().split('\n').map(s=>JSON.parse(s));
    if(header.type!=='header'||JSON.stringify(header.authority)!==JSON.stringify(authority)||!integer(header.startedAt))throw Error('meter_authority_changed');
    const attempts=new Map(), observations=new Map(),receipts=new Set(),counts=Object.fromEntries(kinds.map(k=>[k,0]));
    for(const row of rows) {
      if(row.type==='attempt') {
        validateAttempt(row);
        if(attempts.has(row.operationId))throw Error('invalid_meter_log');
        attempts.set(row.operationId,row);counts[row.kind]++;
      } else if(row.type==='observation') {
        validateObservation(row);
        const prior=observations.get(row.operationId);
        if(!attempts.has(row.operationId)||(prior?!observationAdvance(prior,row):receipts.has(row.providerReceiptId)))throw Error('invalid_meter_log');
        observations.set(row.operationId,row);receipts.add(row.providerReceiptId);
      } else throw Error('invalid_meter_log');
    }
    const actualCostMicroUsd=[...observations.values()].reduce((n,r)=>n+(r.actualCostMicroUsd??0),0);
    const unknownCostOperations=[...attempts.keys()].filter(id=>observations.get(id)?.actualCostMicroUsd==null);
    const retainedHoldMicroUsd=unknownCostOperations.reduce((n,id)=>n+attempts.get(id).maxCostMicroUsd,0);
    const reservedMicroUsd=[...attempts.values()].reduce((n,r)=>n+r.maxCostMicroUsd,0);
    const overage=[...observations.values()].some(r=>r.actualCostMicroUsd>attempts.get(r.operationId).maxCostMicroUsd);
    if(!integer(actualCostMicroUsd)||!integer(reservedMicroUsd)||!integer(retainedHoldMicroUsd)||kinds.some(k=>counts[k]>limits[k])||reservedMicroUsd>maxReservedMicroUsd)throw Error('invalid_meter_log');
    return {header,attempts,observations,receipts,counts,actualCostMicroUsd,unknownCostOperations,retainedHoldMicroUsd,reservedMicroUsd,overage};
  }
  function validateAttempt(row) {if(!kinds.includes(row.kind)||!/^[-A-Za-z0-9:_.]{1,256}$/.test(row.operationId)||(!integer(row.maxCostMicroUsd)||row.maxCostMicroUsd===0))throw Error('invalid_dispatch_intent');}
  function validateObservation(row) {
    if(typeof row.operationId!=='string'||typeof row.providerReceiptId!=='string'||!row.providerReceiptId||!(row.actualCostMicroUsd===null||integer(row.actualCostMicroUsd))||![row.inputTokens,row.outputTokens].every(v=>v===null||integer(v)))throw Error('invalid_observation');
  }
  locked(()=>{try{read();}catch(e){if(e.code!=='ENOENT')throw e;const startedAt=now();if(!integer(startedAt))throw Error('invalid_clock');append({type:'header',authority,startedAt});const fd=openSync(dirname(path),'r');try{fsyncSync(fd);}finally{closeSync(fd);}}});
  return {
    reserve(intent) {return locked(()=>{
      validateAttempt(intent);const state=read();
      if(state.attempts.has(intent.operationId))throw Error('dispatch_already_reserved');
      if(state.overage)throw Error('observed_cost_exceeds_reservation');
      if(now()<state.header.startedAt||now()-state.header.startedAt>=limits.maxElapsedMs||state.counts[intent.kind]>=limits[intent.kind])throw Error('dispatch_cap_or_deadline');
      if(state.reservedMicroUsd+intent.maxCostMicroUsd>maxReservedMicroUsd)throw Error('monetary_reservation_cap');
      append({type:'attempt',operationId:intent.operationId,kind:intent.kind,maxCostMicroUsd:intent.maxCostMicroUsd});
    });},
    observe(value) {return locked(()=>{
      const row={type:'observation',operationId:value.operationId,providerReceiptId:value.providerReceiptId,actualCostMicroUsd:value.actualCostMicroUsd??null,inputTokens:value.inputTokens??null,outputTokens:value.outputTokens??null};validateObservation(row);
      const state=read(), prior=state.observations.get(row.operationId);
      if(prior){if(JSON.stringify(prior)===JSON.stringify(row))return;if(!observationAdvance(prior,row))throw Error('observation_conflict');append(row);return;}
      if(!state.attempts.has(row.operationId))throw Error('observation_without_dispatch');
      if(state.receipts.has(row.providerReceiptId))throw Error('provider_receipt_reused');
      append(row); // Record actual overage before denying any subsequent dispatch.
    });},
    snapshot() {return locked(()=>{const s=read();return {counts:s.counts,actualCostMicroUsd:s.actualCostMicroUsd,unknownCostOperations:s.unknownCostOperations,retainedHoldMicroUsd:s.retainedHoldMicroUsd,reservedMicroUsd:s.reservedMicroUsd,overage:s.overage};});},
  };
}

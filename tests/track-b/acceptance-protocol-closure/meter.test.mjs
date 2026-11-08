import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {APPROVED_CAPS,FULL_OPERATION_PLAN,PLAN_ROWS,planDeficits,createAcceptanceDriver,costEnvelope,createObservationMeter} from '../../../docs/acceptance-protocol-closure/metering/protocol.mjs';
function fixture(t,extra={}) {const dir=mkdtempSync(join(tmpdir(),'acceptance-meter-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'journal.jsonl');const options={maxReservedMicroUsd:1000,...extra};return {path,options,meter:createObservationMeter(path,options)};}
const attempt=(id,kind='target',maxCostMicroUsd=10)=>({operationId:id,kind,maxCostMicroUsd});
test('full plan contains all calls including reproduction judgments and paid SDK polling',()=>{
 for(const kind of ['target','gateway','naive'])assert.equal(PLAN_ROWS.reduce((n,r)=>n+r[kind],0),FULL_OPERATION_PLAN[kind]);
 assert.deepEqual(planDeficits(),{target:45,gateway:34,naive:10,cloudMutation:0});
});
test('approved caps fail before private runtime; cap inflation does not authorize',async()=>{
 let reads=0;const options={limits:APPROVED_CAPS,get privateRuntimeRef(){reads++;throw Error('private runtime read');}};
 await assert.rejects(createAcceptanceDriver(options),/operation_plan_exceeds_approved_caps:target:77/);assert.equal(reads,0);
 await assert.rejects(createAcceptanceDriver({limits:FULL_OPERATION_PLAN,get privateRuntimeRef(){reads++;throw Error('private runtime read');}}),/approved_caps_changed/);
});
test('cost envelope preserves actual call ceilings and explicitly unknown money',()=>{
 const e=costEnvelope({contextBound:100000,judgeReservation:2000,remediationReservation:500});
 assert.equal(e.knownReservationMicroUsd,1206000);assert.equal(e.completeMaximumMicroUsd,null);assert.equal(e.monetaryAuthorization,false);
 assert.deepEqual(e.requestedCompletionTokens,{text:12800,gateway:102400});
 assert.throws(()=>costEnvelope({contextBound:0,judgeReservation:1,remediationReservation:1}),/invalid_cost_bounds/);
});
test('durable attempts survive restart; observations are idempotent and cannot cause a second call',t=>{
 const {path,options,meter}=fixture(t);meter.reserve(attempt('text:1'));
 const row={operationId:'text:1',providerReceiptId:'provider-1',actualCostMicroUsd:3,inputTokens:20,outputTokens:7};meter.observe(row);meter.observe(row);
 const restarted=createObservationMeter(path,options);assert.throws(()=>restarted.reserve(attempt('text:1')),/dispatch_already_reserved/);
 assert.deepEqual(restarted.snapshot(),{counts:{target:1,gateway:0,naive:0,cloudMutation:0},actualCostMicroUsd:3,unknownCostOperations:[],retainedHoldMicroUsd:0,reservedMicroUsd:10,overage:false});
 assert.throws(()=>restarted.observe({...row,actualCostMicroUsd:4}),/observation_conflict/);
});
test('unknown observations retain hold and never become invented zero or token estimate',t=>{
 const {meter}=fixture(t);meter.reserve(attempt('unknown'));meter.observe({operationId:'unknown',providerReceiptId:'receipt',inputTokens:90,outputTokens:22});
 assert.equal(meter.snapshot().retainedHoldMicroUsd,10);assert.deepEqual(meter.snapshot().unknownCostOperations,['unknown']);assert.equal(meter.snapshot().actualCostMicroUsd,0);
});
test('reject unreserved and reused receipt accounting, malformed cost and tokens',t=>{
 const {meter}=fixture(t);meter.reserve(attempt('a'));meter.reserve(attempt('b'));meter.observe({operationId:'a',providerReceiptId:'x',actualCostMicroUsd:1});
 assert.throws(()=>meter.observe({operationId:'b',providerReceiptId:'x',actualCostMicroUsd:1}),/provider_receipt_reused/);
 assert.throws(()=>meter.observe({operationId:'missing',providerReceiptId:'z',actualCostMicroUsd:1}),/observation_without_dispatch/);
 assert.throws(()=>meter.observe({operationId:'b',providerReceiptId:'y',actualCostMicroUsd:-1}),/invalid_observation/);
 assert.throws(()=>meter.observe({operationId:'b',providerReceiptId:'y',actualCostMicroUsd:1,inputTokens:NaN}),/invalid_observation/);
});
test('actual cost overage is retained and stops next dispatch',t=>{
 const {meter}=fixture(t);meter.reserve(attempt('a'));meter.observe({operationId:'a',providerReceiptId:'x',actualCostMicroUsd:20});
 assert.equal(meter.snapshot().actualCostMicroUsd,20);assert.equal(meter.snapshot().overage,true);assert.throws(()=>meter.reserve(attempt('b')),/observed_cost_exceeds_reservation/);
});
test('caps/deadline/monetary exhaustion stop before dispatch including forbidden Naive/cloud',t=>{
 let time=100;const {meter}=fixture(t,{now:()=>time,maxReservedMicroUsd:320});
 assert.throws(()=>meter.reserve(attempt('zero','target',0)),/invalid_dispatch_intent/);
 assert.throws(()=>meter.reserve(attempt('naive','naive')),/dispatch_cap_or_deadline/);assert.throws(()=>meter.reserve(attempt('cloud','cloudMutation')),/dispatch_cap_or_deadline/);
 for(let i=0;i<32;i++)meter.reserve(attempt('t'+i));assert.throws(()=>meter.reserve(attempt('too-many')),/dispatch_cap_or_deadline/);
 assert.throws(()=>meter.reserve(attempt('judging','gateway')),/monetary_reservation_cap/);
 time+=180000;assert.throws(()=>meter.reserve(attempt('late','gateway')),/dispatch_cap_or_deadline/);
 assert.equal(meter.snapshot().counts.target,32);
});
test('torn journals and changed authorities fail closed',t=>{
 const {path,meter}=fixture(t);meter.reserve(attempt('a'));assert.throws(()=>createObservationMeter(path,{maxReservedMicroUsd:1001}),/meter_authority_changed/);
 appendFileSync(path,'{"type":');assert.throws(()=>meter.reserve(attempt('b')),/ambiguous_meter_log/);
});
test('late trusted actual money resolves unknown hold without redispatch or changing measured usage',t=>{
 const {path,options,meter}=fixture(t);meter.reserve(attempt('late'));
 const row={operationId:'late',providerReceiptId:'receipt-late',inputTokens:90,outputTokens:22};
 meter.observe(row);meter.observe({...row,actualCostMicroUsd:6});
 const restart=createObservationMeter(path,options);assert.equal(restart.snapshot().actualCostMicroUsd,6);assert.equal(restart.snapshot().retainedHoldMicroUsd,0);
 assert.throws(()=>restart.reserve(attempt('late')),/dispatch_already_reserved/);
 assert.throws(()=>restart.observe({...row,actualCostMicroUsd:6,inputTokens:91}),/observation_conflict/);
 assert.throws(()=>restart.observe(row),/observation_conflict/);
});

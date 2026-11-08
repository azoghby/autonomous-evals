import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durableMeter } from '../../../docs/track-b-metered-acceptance/meter.mjs';
import { APPROVED, PLAN, createAcceptanceDriver } from '../../../docs/track-b-metered-acceptance/plan.mjs';
import {runMeteredWorker} from '../../../docs/track-b-metered-acceptance/worker-parent.mjs';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const path=()=>join(mkdtempSync(join(tmpdir(),'meter-test-')),'ledger');
test('unchanged cap refusal precedes private references, even expanded numbers do not grant authority',async()=>{
 let reads=0;
 const options={limits:APPROVED,get privateRuntimeRef(){reads++;throw Error('private');}};
 await assert.rejects(createAcceptanceDriver(options),/target:77/);
 options.limits=PLAN; await assert.rejects(createAcceptanceDriver(options),/owner_composition/);
 assert.equal(reads,0);
});
test('shared contention and durable restart count attempts, not successful receipts',async()=>{
 const p=path(),limits={...APPROVED,target:1};
 const a=durableMeter(p,limits),b=durableMeter(p,limits);
 const results=await Promise.allSettled([a.beforeDispatch({kind:'target',operationId:'a'}),b.beforeDispatch({kind:'target',operationId:'b'})]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(durableMeter(p,limits).snapshot().counts.target,1);
 await assert.rejects(durableMeter(p,limits).beforeDispatch({kind:'target',operationId:'a'}));
});
test('abort and corrupt/torn ledger refuse before transport',async()=>{
 const p=path(),c=new AbortController(),m=durableMeter(p,APPROVED,{signal:c.signal});c.abort();
 await assert.rejects(m.beforeDispatch({kind:'target',operationId:'x'}));assert.equal(m.snapshot().counts.target,0);
 appendFileSync(p,'{"type":');
 assert.throws(()=>durableMeter(p,APPROVED),/ambiguous/);
});
test('persisted authority/deadline cannot reset on restart',async()=>{
 const p=path();durableMeter(p,APPROVED,{now:()=>100});
 await assert.rejects(durableMeter(p,APPROVED,{now:()=>180100}).beforeDispatch({kind:'target',operationId:'x'}),/deadline/);
 assert.throws(()=>durableMeter(p,{...APPROVED,target:33}),/authority/);
});
test('actual fork ACK follows durable reservation and count survives worker restart',async()=>{
 const p=path(),modulePath=p+'.mjs';
 writeFileSync(modulePath,`export async function executeAppPhase(input,runtime){await runtime.beforeDispatch({kind:'target',operationId:input.id});runtime.signal.throwIfAborted();return {fixtureOnly:true,pid:process.pid};}`);
 const first=await runMeteredWorker({modulePath,input:{id:'one'},meter:durableMeter(p,APPROVED)});
 assert.equal(first.fixtureOnly,true);assert.notEqual(first.pid,process.pid);
 assert.equal(durableMeter(p,APPROVED).snapshot().counts.target,1);
 await assert.rejects(runMeteredWorker({modulePath,input:{id:'one'},meter:durableMeter(p,APPROVED)}));
 assert.equal(durableMeter(p,APPROVED).snapshot().counts.target,1);
});
test('noncooperative fork is terminated after cancellation without extra dispatches',async()=>{
 const p=path(),modulePath=p+'.mjs',c=new AbortController();
 // Deliberately ignores cancellation. PID is written only to this fixture file.
 writeFileSync(modulePath,`import {writeFileSync} from 'node:fs';export async function executeAppPhase(input){writeFileSync(input.pid,String(process.pid));setInterval(()=>{},10000);return new Promise(()=>{});}`);
 const result=runMeteredWorker({modulePath,input:{pid:p+'.pid'},meter:durableMeter(p,APPROVED,{signal:c.signal})});
 const {readFileSync,existsSync}=await import('node:fs');
 const until=Date.now()+3000;while(!existsSync(p+'.pid')&&Date.now()<until)await new Promise(r=>setTimeout(r,10));
 const pid=Number(readFileSync(p+'.pid','utf8'));c.abort();await assert.rejects(result,/aborted/);
 await new Promise(r=>setTimeout(r,1200));
 assert.throws(()=>process.kill(pid,0));
 assert.equal(durableMeter(p,APPROVED).snapshot().counts.target,0);
});
test('fsync failure rejects durable admission before send and aborts subsequent work',async()=>{
 const p=path(),m=durableMeter(p,APPROVED),original=fs.fsyncSync;let sends=0;
 try {
  fs.fsyncSync=()=>{throw Object.assign(Error('fixture EIO'),{code:'EIO'});};syncBuiltinESMExports();
  await assert.rejects((async()=>{await m.beforeDispatch({kind:'target',operationId:'uncertain'});sends++;})(),/EIO/);
  assert.equal(sends,0);assert.equal(m.signal.aborted,true);
 } finally {fs.fsyncSync=original;syncBuiltinESMExports();}
 // A write may have reached disk before the failed fsync; never refund it.
 assert.equal(durableMeter(p,APPROVED).snapshot().counts.target,1);
});

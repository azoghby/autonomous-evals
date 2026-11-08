import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMediaTransport, createSecuredFetch, FileMediaAuthority } from '../../../packages/core/src/evals/sandbox/multimodal/common';

const url = 'https://ai-gateway.vercel.sh/v4/ai/speech-model';
test('disk replay across reconstruction, identity conflicts, reauthorization and authoritative meter holds', async () => {
 const root = await mkdtemp(join(tmpdir(), 'media-journal-')); let calls = 0, reserved = 0, observed = 0, authorized = 0;
 try {
 const options = () => ({ authority: new FileMediaAuthority(root), fetchImpl: (async () => { calls++; return Response.json({audio:'YWJj'}); }) as typeof fetch,
 meter: { async reserve() { reserved++; }, async observed() { observed++; } }, token: async () => 'credential-fixture', secrets: ['credential-fixture'],
 authorize: async () => { authorized++; }, allowedUrls:[url], maxRequestBytes:1000,maxResponseBytes:1000,timeoutMs:500,maxMicroUsd:50 });
 const request = {operationId:'op',capability:'speech',url,body:'{"text":"hello"}',response:'json' as const};
 const first = await createMediaTransport(options()).dispatch(request);
 assert.deepEqual(await createMediaTransport(options()).dispatch(request), first);
 assert.equal(calls,1); assert.equal(reserved,1); assert.equal(observed,1); assert.equal(authorized,2);
 await assert.rejects(createMediaTransport(options()).dispatch({...request,body:'{}'}));
 await assert.rejects(createMediaTransport({...options(),authorize:async()=>{throw Error('revoked');}}).dispatch(request));
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('unknown dispatch permanently fences retries, including after restart', async () => {
 const root = await mkdtemp(join(tmpdir(),'media-pending-')); let calls=0;
 try {
 const options = () => ({authority:new FileMediaAuthority(root),fetchImpl:(async()=>{calls++;throw Error('private provider details');}) as typeof fetch,
 meter:{async reserve(){},async observed(){}},token:async()=> 'key',secrets:['key'],authorize:async()=>{},allowedUrls:[url],maxRequestBytes:1000,maxResponseBytes:1000,timeoutMs:100,maxMicroUsd:50});
 const r={operationId:'pending',capability:'speech',url,body:'{}',response:'json' as const};
 await assert.rejects(createMediaTransport(options()).dispatch(r),/media_dispatch_failed_or_pending/);
 await assert.rejects(createMediaTransport(options()).dispatch(r)); assert.equal(calls,1);
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('bounds, secret variants, redirects policy, budget denial and noncooperative abort', async () => {
 const root=await mkdtemp(join(tmpdir(),'media-boundary-'));let calls=0;
 try {
 const base={authority:new FileMediaAuthority(root),fetchImpl:(async(_url,init)=>{calls++;assert.equal(init?.redirect,'error');return Response.json({ok:true});}) as typeof fetch,
 meter:{async reserve(){},async observed(){}},token:async()=> 'private-token',secrets:['private-token'],authorize:async()=>{},allowedUrls:[url],maxRequestBytes:1000,maxResponseBytes:1000,timeoutMs:40,maxMicroUsd:50};
 const r={operationId:'bounded',capability:'speech',url,body:'{}',response:'json' as const};
 for(const body of ['private-token',Buffer.from('private-token').toString('base64'),'a'.repeat(1001)]) await assert.rejects(createMediaTransport(base).dispatch({...r,body}));
 await assert.rejects(createMediaTransport(base).dispatch({...r,url:'https://localhost/'})); assert.equal(calls,0);
 await assert.rejects(createMediaTransport({...base,meter:{...base.meter,reserve:async()=>{throw Error('cap');}}}).dispatch({...r,operationId:'cap'})); assert.equal(calls,0);
 await assert.rejects(createMediaTransport({...base,fetchImpl:(async()=>new Promise(()=>{})) as typeof fetch}).dispatch({...r,operationId:'hang'}),/deadline/);
 await assert.rejects(createMediaTransport({...base,fetchImpl:(async()=>Response.json({text:'private-token'})) as typeof fetch}).dispatch({...r,operationId:'leak'}));
 await assert.rejects(createMediaTransport({...base,fetchImpl:(async()=>Response.json({text:'x'.repeat(2000)})) as typeof fetch}).dispatch({...r,operationId:'oversize'}));
 await assert.rejects(createMediaTransport({...base,fetchImpl:undefined}).dispatch(r),/unsupported/);
 } finally{await rm(root,{recursive:true,force:true});}
});
test('A/SDK fetch adapter uses deterministic operation sequence and exact headers/body',async()=>{
 const seen:string[]=[];
 const f=createSecuredFetch({async dispatch(r){seen.push(r.operationId);assert.equal(r.headers?.['ai-model-id'],'speech/model');assert.equal(r.body,'{}');return {bytes:new TextEncoder().encode('{"ok":true}'),contentType:'application/json',elapsedMs:1,responseDigest:'fixture'};}},'trial','tts');
 assert.deepEqual(await (await f(url,{method:'POST',headers:{'ai-model-id':'speech/model'},body:'{}'})).json(),{ok:true});
 await f(url,{method:'POST',headers:{'ai-model-id':'speech/model'},body:'{}'});assert.deepEqual(seen,['trial:0','trial:1']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMultimodalBridge, createPinnedTargetFetch } from '../../../packages/core/src/evals/sandbox/multimodal/bridge';
import { FileMediaAuthority } from '../../../packages/core/src/evals/sandbox/multimodal/common';
import type { MediaBridgeOptions } from '../../../packages/core/src/evals/sandbox/multimodal/bridge';
import type { ReceiptVisionInput } from '../../../packages/core/src/evals/sandbox/multimodal/vision';
const input:ReceiptVisionInput={operationId:'receipt',attachment:{id:'receipt',kind:'image',source:'render',prompt:'template:receipt',groundTruth:{total:'47.20'},perturbations:[]},oracleModel:'google/gemini-3-flash',targetModel:'customer-vision',seed:1,maxBytes:2000000};
function options(root:string):MediaBridgeOptions{return{binding:{jobId:'job',trialId:'trial',approvalId:'approval',suiteDigest:'a'.repeat(64),environmentDigest:'b'.repeat(64),runtimeVersion:'runtime1',targetConfigDigest:'c'.repeat(64),mediaConfigDigest:'d'.repeat(64)},authority:new FileMediaAuthority(root),authorize:async()=>{},secrets:['fixture-secret'],maxArtifactBytes:100000,timeoutMs:1000,
 transport:{async dispatch(){return {bytes:new TextEncoder().encode(JSON.stringify({content:[{type:'text',text:JSON.stringify({fields:{total:'47.20'},other_text:[]})}],finishReason:{unified:'stop',raw:'stop'},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}},warnings:[]})),contentType:'application/json',elapsedMs:1,responseDigest:'fixture'};}}};}
test('whole trial replay across restart does not redispatch target; authorization and binding conflicts checked',async()=>{
 const root=await mkdtemp(join(tmpdir(),'media-bridge-'));let calls=0;
 try {const opts=options(root); const target=async(a:{sha256:string;model:string})=>{calls++;return{model:a.model,deliveredAssetSha256:a.sha256,toolCalls:[],transcript:[{role:'assistant' as const,content:'47.20'}],elapsedMs:1};};
 const first=await createMultimodalBridge(opts).receipt(input,target);
 assert.deepEqual(await createMultimodalBridge({...opts,authority:new FileMediaAuthority(root)}).receipt(input,target),first);assert.equal(calls,1);
 await assert.rejects(createMultimodalBridge({...opts,authorize:async()=>{throw Error('revoked');}}).receipt(input,target));
 await assert.rejects(createMultimodalBridge({...opts,binding:{...opts.binding,approvalId:'replacement'}}).receipt(input,target));assert.equal(calls,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('ambiguous target stays fenced after restart and secret receipt cannot persist',async()=>{
 const root=await mkdtemp(join(tmpdir(),'media-bridge-pending-'));
 try {const opts=options(root);let calls=0;const bad=async()=>{calls++;throw Error('unknown delivery');};
 await assert.rejects(createMultimodalBridge(opts).receipt(input,bad));
 await assert.rejects(createMultimodalBridge({...opts,authority:new FileMediaAuthority(root)}).receipt(input,bad));assert.equal(calls,1);
 await assert.rejects(createMultimodalBridge(opts).receipt({...input,operationId:'secret',attachment:{...input.attachment,groundTruth:{total:'fixture-secret'}}},bad),/secret/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('existing secured target URL gate applies separately to binary chat fetch',async()=>{
 const seen:unknown[]=[];const fetcher=createPinnedTargetFetch({}, {async post(url,body,bearer){seen.push({url,body,bearer});return{choices:[]};}});
 for(const url of ['http://example.com','https://localhost/x','https://user:password@example.com','https://example.com/x?redirect=1'])await assert.rejects(fetcher(url,{method:'POST',body:'{}',headers:{authorization:'Bearer fixture'}}));
 const privateDns=createPinnedTargetFetch({resolver:async()=>[{address:'127.0.0.1',family:4}]});
 await assert.rejects(privateDns('https://customer.example/chat',{method:'POST',body:'{}',headers:{authorization:'Bearer fixture'}}),/blocked_address/);
 assert.equal(seen.length,0);
 assert.deepEqual(await (await fetcher('https://customer.example/chat',{method:'POST',body:'{"messages":[]}',headers:{authorization:'Bearer fixture'}})).json(),{choices:[]});assert.equal(seen.length,1);
});

test('factory composes rendered PNG, metered SDK oracle, secured binary chat and durable actual tool replay',async()=>{
 const {createReceiptChatTarget}=await import('../../../packages/core/src/evals/sandbox/multimodal/vision');
 const {createMediaTransport}=await import('../../../packages/core/src/evals/sandbox/multimodal/common');
 const root=await mkdtemp(join(tmpdir(),'media-composed-'));let dispatches=0,reserved=0,observed=0,tools=0;
 try{
 const base=options(root);const oracle=base.transport;
 const targetUrl='https://customer.example/chat';
 const transport=createMediaTransport({authority:new FileMediaAuthority(join(root,'dispatch')),allowedUrls:['https://ai-gateway.vercel.sh/v4/ai/language-model',targetUrl],authorize:async()=>{},token:async()=> 'fixture-credential',secrets:['fixture-credential'],maxRequestBytes:2000000,maxResponseBytes:100000,timeoutMs:1000,maxMicroUsd:100,
 meter:{async reserve(){reserved++;},async observed(){observed++;}},fetchImpl:(async(url,init)=>{
 dispatches++;const body=JSON.parse(String(init?.body));
 if(String(url)!==targetUrl){const r=await oracle.dispatch({operationId:'fixture',capability:'vision',url:String(url),body:String(init?.body),response:'json'});return new Response(new Uint8Array(r.bytes),{headers:{'content-type':'application/json'}});}
 assert(JSON.stringify(body.messages).includes('data:image/png;base64,'));
 const hasTool=body.messages.some((m:{role:string})=>m.role==='tool');
 return Response.json({choices:[{finish_reason:hasTool?'stop':'tool_calls',message:{role:'assistant',content:hasTool?'47.20':null,...(hasTool?{}:{tool_calls:[{id:'c1',type:'function',function:{name:'refund',arguments:'{"total":"47.20"}'}}]})}}]});
 }) as typeof fetch});
 const config={endpointUrl:targetUrl,model:input.targetModel,maxToolRounds:3,maxToolCalls:2,tools:[{name:'refund',description:'Process approved receipt',parameters:{type:'object',properties:{total:{type:'string'}}}}],validateToolArgs(_name:string,args:unknown){assert.deepEqual(args,{total:'47.20'});}};
 const target=createReceiptChatTarget({...config,transport,callTool:async()=>{throw Error('only used for config digest');}});
 const opts={...base,transport,binding:{...base.binding,targetConfigDigest:target.configDigest}};
 const run={async callTool(name:string,args:unknown){tools++;return{seq:1,tool:name,args,result:{ok:true},ms:1,executed:true};}};
 const first=await createMultimodalBridge(opts).receiptChat(input,config,run);
 assert(first.perception.every(x=>x.passed));assert.equal(tools,1);assert.equal(dispatches,3);assert.equal(reserved,3);assert.equal(observed,3);
 assert.deepEqual(await createMultimodalBridge({...opts,authority:new FileMediaAuthority(root)}).receiptChat(input,config,run),first);assert.equal(tools,1);assert.equal(dispatches,3);
 await assert.rejects(createMultimodalBridge(opts).receiptChat(input,{...config,systemPrompt:'changed'},run),/configuration_conflict/);
 }finally{await rm(root,{recursive:true,force:true});}
});

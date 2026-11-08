import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runReceiptVision, createReceiptOracleGateway, createReceiptChatTarget } from '../../../packages/core/src/evals/sandbox/multimodal/vision';
import type { ReceiptVisionInput, ReceiptVisionPorts } from '../../../packages/core/src/evals/sandbox/multimodal/vision';
import type { MediaTransport } from '../../../packages/core/src/evals/sandbox/multimodal/common';

const hash=(x:Uint8Array)=>createHash('sha256').update(x).digest('hex');
const input:ReceiptVisionInput={operationId:'receipt-1',attachment:{id:'receipt',kind:'image',source:'render',prompt:'template:receipt',groundTruth:{merchant:'ACME',total:'47.20'},perturbations:[]},oracleModel:'google/gemini-3-flash',targetModel:'anthropic/claude-sonnet-5.5',seed:7,maxBytes:2_000_000,maxTargetLatencyMs:20};
function fixture(options:{total?:string;targetTotal?:string;badDigest?:boolean;latency?:number}={}) {
 const requests:any[]=[];let targetCalls=0;
 const transport:MediaTransport={async dispatch(r){requests.push(r);const text=JSON.stringify({fields:{merchant:'ACME',total:options.total??'47.20'},other_text:[]});
 const body=JSON.stringify({content:[{type:'text',text}],finishReason:{unified:'stop',raw:'stop'},usage:{inputTokens:{total:10,noCache:10,cacheRead:0,cacheWrite:0},outputTokens:{total:10,text:10,reasoning:0}},warnings:[]});
 const bytes=new TextEncoder().encode(body);return{bytes,contentType:'application/json',elapsedMs:1,responseDigest:hash(bytes)};}};
 const saved=new Map<string,{hash:string;value:unknown}>();
 const ports:ReceiptVisionPorts={transport,targetConfigDigest:'a'.repeat(64),async once<T>(id:string,digest:string,work:()=>Promise<T>){const old=saved.get(id);if(old){if(old.hash!==digest)throw Error('replay_conflict');return structuredClone(old.value) as T;}const value=await work();saved.set(id,{hash:digest,value});return value;},async target(a){targetCalls++;assert.equal(hash(a.bytes),a.sha256);assert.equal(Buffer.from(a.bytes.subarray(0,8)).toString('hex'),'89504e470d0a1a0a');assert.equal('groundTruth' in a,false);return{model:a.model,deliveredAssetSha256:options.badDigest?'bad':a.sha256,toolCalls:[],transcript:[{role:'assistant',content:`ACME ${options.targetTotal??'47.20'}`}],elapsedMs:options.latency??10};}};
 return{ports,requests,get targetCalls(){return targetCalls;}};
}
test('actual Track A PNG rendering + SDK native oracle protocol + binary target perception + replay',async()=>{
 const f=fixture();const result=await runReceiptVision(input,f.ports);assert(result.oracle.accepted);assert(result.perception.every(c=>c.passed));assert(result.latency.checks.every(c=>c.passed));assert.equal(result.cost.status,'unknown');assert.equal(f.targetCalls,1);
 assert.equal(f.requests.length,1);assert.match(f.requests[0].url,/language-model$/);const wire=JSON.parse(String(f.requests[0].body));
 assert(!JSON.stringify(wire.prompt).includes('47.20'));assert(!JSON.stringify(wire.prompt).includes('ACME'));assert(JSON.stringify(wire.prompt).includes('merchant'));assert(JSON.stringify(wire.prompt).includes('image/png'));
 assert.deepEqual(await runReceiptVision(input,f.ports),result);assert.equal(f.targetCalls,1);assert.equal(f.requests.length,1);
 await assert.rejects(runReceiptVision({...input,seed:8},f.ports),/replay_conflict/);
});
test('independent oracle rejects wrong visible total before binary target dispatch',async()=>{
 const f=fixture({total:'48.20'});await assert.rejects(runReceiptVision(input,f.ports),/vision_oracle_rejected/);assert.equal(f.targetCalls,0);
});
test('target actual reply mismatch and latency produce failing evidence',async()=>{
 const f=fixture({targetTotal:'48.20',latency:30});const result=await runReceiptVision(input,f.ports);assert.equal(result.perception.find(x=>x.id.endsWith('.total'))?.passed,false);assert.equal(result.latency.checks[0].passed,false);
});
test('delivery hash mismatch and absent transport cannot become perception success',async()=>{
 const f=fixture({badDigest:true});await assert.rejects(runReceiptVision(input,f.ports),/vision_target_identity_invalid/);const g=fixture();g.ports.target=undefined;await assert.rejects(runReceiptVision(input,g.ports),/unsupported_media:binary_vision_target_transport/);assert.equal(g.requests.length,0);
});
test('empty ground truth, unsupported perturbations, same oracle/target model and abort reject before network',async()=>{
 const f=fixture();await assert.rejects(runReceiptVision({...input,attachment:{...input.attachment,groundTruth:{}}},f.ports),/groundtruth/);
 await assert.rejects(runReceiptVision({...input,attachment:{...input.attachment,perturbations:['blur']}},f.ports),/unsupported/);
 await assert.rejects(runReceiptVision({...input,targetModel:input.oracleModel},f.ports),/input_invalid/);
 const controller=new AbortController();controller.abort();await assert.rejects(runReceiptVision(input,f.ports,controller.signal));assert.equal(f.requests.length,0);
});
test('receipt oracle gateway rejects other capabilities and malformed provider JSON response',async()=>{
 const f=fixture();const gw=createReceiptOracleGateway(f.ports.transport,'x');await assert.rejects(gw.transcribe({model:'x',audio:new Uint8Array()}),/unsupported/);
 const transport:MediaTransport={async dispatch(){const bytes=new TextEncoder().encode('{}');return{bytes,contentType:'application/json',elapsedMs:0,responseDigest:hash(bytes)};}};
 await assert.rejects(createReceiptOracleGateway(transport,'x').vision({model:'google/gemini-3-flash',image:new Uint8Array([1]),mediaType:'image/png',prompt:'read'}));
});

test('hung target is bounded by receipt deadline',async()=>{const f=fixture();f.ports.target=()=>new Promise(()=>{});await assert.rejects(runReceiptVision({...input,timeoutMs:100},f.ports),/vision_aborted/);});

test('rendered receipt passes SDK oracle then concrete chat image payload -> real tool record -> perception',async()=>{
 const f=fixture();const targetRequests:any[]=[];let tools=0;
 const targetTransport:MediaTransport={async dispatch(r){targetRequests.push(JSON.parse(String(r.body)));const message=targetRequests.length===1?{role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'record_receipt',arguments:JSON.stringify({merchant:'ACME',total:'47.20'})}}]}:{role:'assistant',content:'Receipt recorded'};
 const bytes=new TextEncoder().encode(JSON.stringify({choices:[{message,finish_reason:targetRequests.length===1?'tool_calls':'stop'}]}));return{bytes,contentType:'application/json',elapsedMs:1,responseDigest:hash(bytes)};}};
 f.ports.target=createReceiptChatTarget({endpointUrl:'https://target.example/v1/chat/completions',model:input.targetModel,maxToolRounds:3,maxToolCalls:2,transport:targetTransport,tools:[{name:'record_receipt',description:'Record receipt',parameters:{type:'object',properties:{merchant:{type:'string'},total:{type:'string'}},required:['merchant','total'],additionalProperties:false}}],validateToolArgs(name,args){assert.equal(name,'record_receipt');assert.deepEqual(args,{merchant:'ACME',total:'47.20'});},async callTool(name,args){tools++;return{seq:1,tool:name,args,result:{recorded:true},ms:1};}});
 f.ports.targetConfigDigest=(f.ports.target as ReturnType<typeof createReceiptChatTarget>).configDigest;
 const result=await runReceiptVision(input,f.ports);assert.equal(tools,1);assert.equal(result.target.toolCalls.length,1);assert(result.perception.every(x=>x.passed));
 const image=targetRequests[0].messages[0].content.find((x:any)=>x.type==='image_url');assert.match(image.image_url.url,/^data:image\/png;base64,/);assert.equal(hash(Buffer.from(image.image_url.url.split(',')[1],'base64')),result.provenance.assetSha256);
 assert.equal(targetRequests[1].messages.at(-1).role,'tool');assert.equal(targetRequests[1].messages.at(-1).content,'{"recorded":true}');
});
test('concrete image target refuses undeclared tool and enforces round bound',async()=>{
 let count=0;const transport:MediaTransport={async dispatch(){count++;const bytes=new TextEncoder().encode(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'c'+count,type:'function',function:{name:'unknown',arguments:'{}'}}]},finish_reason:'tool_calls'}]}));return{bytes,contentType:'application/json',elapsedMs:1,responseDigest:hash(bytes)};}};
 const target=createReceiptChatTarget({endpointUrl:'https://target.example/v1/chat/completions',model:input.targetModel,maxToolRounds:1,maxToolCalls:1,transport,tools:[],validateToolArgs(){throw Error('must not validate');},async callTool(){throw Error('must not execute');}});
 const bytes=new Uint8Array([1]);await assert.rejects(target({operationId:'target',model:input.targetModel,bytes,mediaType:'image/png',sha256:hash(bytes)}),/vision_target_tool_invalid/);assert.equal(count,1);
 const looping=createReceiptChatTarget({endpointUrl:'https://target.example/v1/chat/completions',model:input.targetModel,maxToolRounds:1,maxToolCalls:1,transport,tools:[{name:'unknown',description:'test',parameters:{type:'object'}}],validateToolArgs(){},async callTool(tool,args){return{seq:1,tool,args,result:{ok:true},ms:1};}});
 await assert.rejects(looping({operationId:'loop',model:input.targetModel,bytes,mediaType:'image/png',sha256:hash(bytes)}),/vision_target_round_bound/);
});

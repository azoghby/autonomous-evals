/** Track B authority bridge over Track A media at fc45714. No platform/runtime adoption. */
import { createHash } from 'node:crypto';
import { generateText } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import type { CheckResult, MediaAttachment, ToolCallRecord } from '../../../sandbox/spec';
import type { MediaGateway } from '../../../sandbox/media/client';
import { materializeAttachment } from '../../../sandbox/media/generate';
import { runMediaOracle } from '../../../sandbox/media/oracle';
import { gradePerception, targetsFromAttachments, gradeLatency } from '../../../sandbox/media/perception';
import { createSecuredFetch, type MediaTransport } from './common';

const digest = (x: Uint8Array | string) => createHash('sha256').update(x).digest('hex');
export const TRACK_A_MEDIA_REF = 'fc45714' as const;
export interface VisionTargetEvidence {
  /** Authority must bind this digest to the binary payload actually delivered to the target. */
  deliveredAssetSha256: string;
  model: string;
  toolCalls: ToolCallRecord[];
  transcript: Array<{role:'user'|'assistant'|'tool';content:string}>;
  elapsedMs: number;
}
export interface ReceiptVisionInput {
  operationId: string;
  attachment: MediaAttachment;
  oracleModel: string;
  targetModel: string;
  seed: number;
  maxBytes: number;
  maxTargetLatencyMs?: number;
  timeoutMs?: number;
}
export interface ReceiptVisionPorts {
  /** Durable non-expiring whole-operation fence; conflicting digest/pending intent must refuse dispatch. */
  once<T>(operationId:string, identityDigest:string, work:()=>Promise<T>):Promise<T>;
  /** Server-owned bounded SDK protocol transport. Never accept this from scenario JSON. */
  transport: MediaTransport;
  /** Exact server-held target/tool/system configuration pin, rechecked by authority on replay. */
  targetConfigDigest: string;
  /** Binary-capable secured target; the existing text runner cannot implement this port. */
  target?: (input:{operationId:string; model:string; bytes:Uint8Array;mediaType:'image/png';sha256:string},signal?:AbortSignal)=>Promise<VisionTargetEvidence>;
}

/** Uses the current Gateway SDK's real serializer/parser with zero SDK retries. B transport owns credentials and metering.
 * A's default client is intentionally not constructed: it reads ambient credentials and estimates unsettled costs. */
export function createReceiptOracleGateway(transport:MediaTransport, operationId:string, signal?:AbortSignal):MediaGateway {
  const gateway = createGateway({apiKey:'injected-transport',fetch:createSecuredFetch(transport,operationId,'vision')});
  const unsupported = async ():Promise<never> => {throw new Error('unsupported_media:receipt_oracle_only');};
  return {
    async vision(a) {
      if(a.mediaType !== 'image/png' || !a.model || a.image.length === 0) throw new Error('vision_request_invalid');
      const started = performance.now();
      const res = await generateText({model:gateway(a.model), system:a.system,
        messages:[{role:'user',content:[{type:'text',text:a.prompt},{type:'file',mediaType:a.mediaType,data:a.image}]}],
        temperature:0,maxOutputTokens:a.maxOutputTokens ?? 1000,maxRetries:0,abortSignal:signal});
      if(res.warnings?.length)throw new Error('vision_provider_warning');
      if(!res.text || res.text.length>16000) throw new Error('vision_response_invalid');
      // Compatibility field only. Never expose this zero as a settled cost; transport retains authoritative holds/usage.
      return {text:res.text,microUsd:0,latencyMs:performance.now()-started,model:a.model,warnings:(res.warnings??[]).map(x=>JSON.stringify(x))};
    }, speak:unsupported,transcribe:unsupported,image:unsupported,
  };
}

/** Ground truth stays inside the trusted receipt renderer + comparator. Target sees only PNG bytes; oracle sees field names. */
export async function runReceiptVision(input:ReceiptVisionInput, ports:ReceiptVisionPorts, signal?:AbortSignal) {
  const a = structuredClone(input.attachment);
  const timeoutMs=input.timeoutMs??60_000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60_000)throw new Error('vision_timeout_invalid');
  signal=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(timeoutMs)]);
  const bounded=<T>(operation:Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
    const abort=()=>reject(new Error('vision_aborted'));
    signal!.addEventListener('abort',abort,{once:true});
    operation.then(resolve,reject).finally(()=>signal!.removeEventListener('abort',abort));
    if(signal!.aborted)abort();
  });
  if(!input.operationId || !input.oracleModel || !input.targetModel || input.oracleModel===input.targetModel
    || !Number.isSafeInteger(input.seed) || input.seed<0 || !Number.isSafeInteger(input.maxBytes) || input.maxBytes<1 || input.maxBytes>10_000_000
    || (input.maxTargetLatencyMs!==undefined && (!Number.isFinite(input.maxTargetLatencyMs)||input.maxTargetLatencyMs<=0))) throw new Error('vision_input_invalid');
  if(a.source!=='render'||a.kind!=='image'||a.prompt!=='template:receipt'||a.perturbations.length) throw new Error('unsupported_media:receipt_source_or_perturbation');
  const entries=Object.entries(a.groundTruth);
  if(entries.length===0||entries.length>20||entries.some(([k,v])=>!k||k.length>60||!v.trim()||v.length>200)||a.injection && a.injection.length>1000) throw new Error('vision_groundtruth_invalid');
  if(!/^[a-f0-9]{64}$/.test(ports.targetConfigDigest))throw new Error('vision_target_config_digest_invalid');
  if(!ports.target) throw new Error('unsupported_media:binary_vision_target_transport');
  signal?.throwIfAborted();
  const identityDigest=digest(JSON.stringify({trackA:TRACK_A_MEDIA_REF,...input,attachment:a,targetConfigDigest:ports.targetConfigDigest}));
  return ports.once(input.operationId,identityDigest,async()=>{
    signal?.throwIfAborted();
    const gw=createReceiptOracleGateway(ports.transport,`${input.operationId}:oracle`,signal);
    const asset=await bounded(materializeAttachment(gw,a,{seed:input.seed}));
    signal?.throwIfAborted();
    if(asset.mediaType!=='image/png'||asset.bytes.length>input.maxBytes||asset.bytes.length<8||Buffer.from(asset.bytes.subarray(0,8)).toString('hex')!=='89504e470d0a1a0a') throw new Error('vision_asset_invalid');
    const assetSha256=digest(asset.bytes);
    const oracle=await bounded(runMediaOracle(gw,{kind:'image',bytes:asset.bytes,mediaType:asset.mediaType,groundTruth:a.groundTruth,injection:asset.injection},{model:input.oracleModel}));
    signal?.throwIfAborted();
    if(!oracle.accepted||oracle.fields.length!==entries.length||oracle.fields.some(f=>!f.matched||f.read===null)) throw new Error('vision_oracle_rejected');
    const target=await bounded(ports.target!({operationId:`${input.operationId}:target`,model:input.targetModel,bytes:new Uint8Array(asset.bytes),mediaType:'image/png',sha256:assetSha256},signal));
    signal?.throwIfAborted();
    if(target.model!==input.targetModel||target.deliveredAssetSha256!==assetSha256||!Number.isFinite(target.elapsedMs)||target.elapsedMs<0) throw new Error('vision_target_identity_invalid');
    const perception:CheckResult[]=gradePerception({targets:targetsFromAttachments([a]),toolCalls:target.toolCalls,transcript:target.transcript});
    const latency=gradeLatency([{turn:0,userEndMs:0,agentEndMs:target.elapsedMs}],input.maxTargetLatencyMs===undefined?{}:{turnP95Ms:input.maxTargetLatencyMs});
    return {identityDigest,provenance:{trackARef:TRACK_A_MEDIA_REF,source:'render' as const,template:'receipt' as const,assetSha256,bytes:asset.bytes.length,oracleModel:input.oracleModel,targetModel:input.targetModel,targetConfigDigest:ports.targetConfigDigest,oracleOperationId:`${input.operationId}:oracle`,targetOperationId:`${input.operationId}:target`},
      oracle:{accepted:true,fields:oracle.fields.map(f=>({...f})),injection:oracle.injection},perception,latency,
      /** No paid settlement implied by Track A's mandatory numeric compatibility fields. */
      cost:{status:'unknown' as const,microUsd:null},target:structuredClone(target)};
  });
}

/** Additive binary chat driver: Track A's text-only execution runner is not modified.
 * Owner binds callTool to the already isolated trial world and validates its declared schema. */
export function createReceiptChatTarget(config:{
  endpointUrl:string;model:string;systemPrompt?:string;maxToolRounds:number;maxToolCalls:number;
  tools:Array<{name:string;description:string;parameters:Record<string,unknown>}>;
  transport:MediaTransport;
  validateToolArgs:(name:string,args:unknown)=>void;
  callTool:(name:string,args:unknown,signal?:AbortSignal)=>Promise<ToolCallRecord>;
}):NonNullable<ReceiptVisionPorts['target']> & {readonly configDigest:string} {
  const pin=structuredClone({endpointUrl:config.endpointUrl,model:config.model,systemPrompt:config.systemPrompt,tools:config.tools});
  const url=new URL(pin.endpointUrl);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||!pin.model||pin.tools.length>60
    ||new Set(pin.tools.map(t=>t.name)).size!==pin.tools.length||pin.tools.some(t=>!/^\w{1,64}$/.test(t.name))
    ||!Number.isSafeInteger(config.maxToolRounds)||config.maxToolRounds<1||config.maxToolRounds>12
    ||!Number.isSafeInteger(config.maxToolCalls)||config.maxToolCalls<1||config.maxToolCalls>30)throw new Error('vision_target_config_invalid');
  const driver:NonNullable<ReceiptVisionPorts['target']>=async(input,signal)=>{
    if(input.model!==pin.model||input.sha256!==digest(input.bytes))throw new Error('vision_target_input_identity');
    const started=performance.now();
    const messages:Array<Record<string,unknown>>=[];
    if(pin.systemPrompt)messages.push({role:'system',content:pin.systemPrompt});
    messages.push({role:'user',content:[{type:'text',text:'Read the attached receipt and complete the task using the available tools.'},{type:'image_url',image_url:{url:`data:image/png;base64,${Buffer.from(input.bytes).toString('base64')}`,detail:'high'}}]});
    const transcript:VisionTargetEvidence['transcript']=[];const toolCalls:ToolCallRecord[]=[];const ids=new Set<string>();
    for(let round=0;round<config.maxToolRounds;round++){
      signal?.throwIfAborted();
      const res=await config.transport.dispatch({operationId:`${input.operationId}:round:${round}`,capability:'vision_target',url:pin.endpointUrl,body:JSON.stringify({model:pin.model,messages,tools:pin.tools.map(t=>({type:'function',function:t})),parallel_tool_calls:false,temperature:0,max_tokens:1000,stream:false}),headers:{'content-type':'application/json'},response:'json',signal});
      const parsed:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(res.bytes));
      if(!parsed||typeof parsed!=='object')throw new Error('vision_target_response_invalid');
      const choices=(parsed as any).choices;
      if(!Array.isArray(choices)||choices.length!==1||choices[0]?.finish_reason==='length')throw new Error('vision_target_response_invalid');
      const msg=choices[0].message;
      if(!msg||msg.role!=='assistant'||(msg.content!==null&&typeof msg.content!=='string')||(typeof msg.content==='string'&&msg.content.length>16000))throw new Error('vision_target_response_invalid');
      const batch=msg.tool_calls??[];
      if(!Array.isArray(batch)||batch.length+toolCalls.length>config.maxToolCalls)throw new Error('vision_target_tool_bound');
      if(!batch.length){
        if(!msg.content?.trim()||choices[0].finish_reason!=='stop')throw new Error('vision_target_incomplete');
        transcript.push({role:'assistant',content:msg.content});
        return{model:pin.model,deliveredAssetSha256:input.sha256,toolCalls,transcript,elapsedMs:performance.now()-started};
      }
      messages.push({role:'assistant',content:msg.content,tool_calls:batch});
      if(msg.content)transcript.push({role:'assistant',content:msg.content});
      for(const call of batch){
        if(call.type!=='function'||typeof call.id!=='string'||!call.id||ids.has(call.id)||!pin.tools.some(t=>t.name===call.function?.name)||typeof call.function?.arguments!=='string'||call.function.arguments.length>16000)throw new Error('vision_target_tool_invalid');
        ids.add(call.id);const args:unknown=JSON.parse(call.function.arguments);config.validateToolArgs(call.function.name,args);
        signal?.throwIfAborted();
        const actual=await config.callTool(call.function.name,structuredClone(args),signal);
        if(actual.tool!==call.function.name||JSON.stringify(actual.args)!==JSON.stringify(args))throw new Error('vision_target_tool_record_mismatch');
        toolCalls.push(structuredClone(actual));
        const result=JSON.stringify(actual.error?{error:actual.error}:actual.result);
        if(result.length>32000)throw new Error('vision_target_tool_result_bound');
        messages.push({role:'tool',tool_call_id:call.id,content:result});
      }
    }
    throw new Error('vision_target_round_bound');
  };
  return Object.assign(driver,{configDigest:digest(JSON.stringify({version:'receipt-chat-v1',...pin,maxToolCalls:config.maxToolCalls,maxToolRounds:config.maxToolRounds}))});
}

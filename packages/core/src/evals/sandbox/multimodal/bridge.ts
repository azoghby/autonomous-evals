import { HttpsJsonTransport, targetUrl, type JsonTransport, type TransportOptions as TargetLimits } from '../../../targets/transport';
import { assertNoSecrets, digest, type DurableAuthority, type MediaTransport } from './common';
import { runBufferedVoiceTrial, type BufferedVoiceTrialInput } from './voice';
import { runReceiptVision, createReceiptChatTarget, type ReceiptVisionInput, type ReceiptVisionPorts } from './vision';
import type { ToolCallRecord } from '../../../sandbox/spec';

/** The exact existing secured target transport: public DNS pin, TLS hostname verification,
 * no redirects/proxies/pooling and bounded JSON. No network occurs until dispatched. */
export function createPinnedTargetFetch(limits: TargetLimits = {}, injected?: JsonTransport): typeof fetch {
  const transport = injected ?? new HttpsJsonTransport(limits);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = targetUrl(String(input));
    if (init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('unsupported_target_media_request');
    init.signal?.throwIfAborted();
    const auth = new Headers(init.headers).get('authorization');
    if (!auth?.startsWith('Bearer ')) throw new Error('media_target_credential_required');
    const result = await transport.post(url.href, JSON.parse(init.body), auth.slice(7));
    init.signal?.throwIfAborted();
    return Response.json(result);
  }) as typeof fetch;
}
export interface MediaTrialBinding {
  jobId: string; trialId: string; approvalId: string; suiteDigest: string; environmentDigest: string;
  runtimeVersion: string; targetConfigDigest: string; mediaConfigDigest: string;
}
export interface MediaBridgeOptions {
  binding: MediaTrialBinding;
  authority: DurableAuthority;
  /** Must recheck caller ownership, exact approval and the scoped runtime on EVERY replay. */
  authorize(binding: Readonly<MediaTrialBinding>): Promise<void>;
  transport: MediaTransport;
  secrets: readonly string[];
  maxArtifactBytes: number;
  timeoutMs: number;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
}
/** Supplemental bridge: caller supplies the already isolated run and final state grader.
 * It never provisions, disposes or changes the text runner, and cannot project a settled TrialResult. */
export function createMultimodalBridge(options: MediaBridgeOptions) {
  const binding = Object.freeze(structuredClone(options.binding));
  const secrets = [...options.secrets];
  if (Object.values(binding).some(x=>!x) || ![binding.suiteDigest,binding.environmentDigest,binding.targetConfigDigest,binding.mediaConfigDigest].every(x=>/^[a-f0-9]{64}$/.test(x))
    || !Number.isSafeInteger(options.maxArtifactBytes)||options.maxArtifactBytes<1||!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>300000) throw new Error('media_bridge_invalid');
  async function once<T>(key:string, identity:string, work:()=>Promise<T>, signal?:AbortSignal):Promise<T> {
    signal?.throwIfAborted();
    await options.authorize(binding);
    signal?.throwIfAborted();
    const requestIdentity=digest(canonical({binding,identity}));
    const op=`media-trial:${binding.jobId}:${binding.trialId}:${key}`;
    const claim=await options.authority.claim(op,requestIdentity);
    if(claim.state==='pending')throw new Error('media_trial_pending_reconciliation');
    if(claim.state==='completed') {
      if(claim.result.bytes.length>options.maxArtifactBytes||digest(claim.result.bytes)!==claim.result.responseDigest)throw new Error('media_trial_replay_corrupt');
      assertNoSecrets(claim.result.bytes,secrets);
      return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(claim.result.bytes)) as T;
    }
    const value=await work();
    signal?.throwIfAborted();
    const bytes=new TextEncoder().encode(JSON.stringify(value));
    if(bytes.length>options.maxArtifactBytes)throw new Error('media_artifact_bound');
    assertNoSecrets(bytes,secrets);
    await options.authority.complete(op,requestIdentity,{bytes,contentType:'application/json',elapsedMs:0,responseDigest:digest(bytes)});
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }
  async function bounded<T>(signal:AbortSignal|undefined,work:(s:AbortSignal)=>Promise<T>):Promise<T> {
    const controller=new AbortController(); const abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(abort,options.timeoutMs);
    try{return await new Promise<T>((resolve,reject)=>{
      controller.signal.addEventListener('abort',()=>reject(new Error('media_trial_aborted_unknown')),{once:true});
      if(controller.signal.aborted)reject(new Error('media_trial_aborted_unknown'));
      else void work(controller.signal).then(resolve,()=>reject(new Error('media_trial_failed_or_pending')));
    });}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  return {
    binding,
    async voice(input:BufferedVoiceTrialInput,run:{callTool(name:string,args:unknown):Promise<ToolCallRecord>},signal?:AbortSignal){
      const frozen=structuredClone(input);assertNoSecrets(canonical(frozen),secrets);
      return bounded(signal,s=>once(frozen.operationId,digest(canonical({kind:'voice',input:frozen})),()=>runBufferedVoiceTrial(frozen,{transport:options.transport,callTool:async(name,args)=>{
        s.throwIfAborted();assertNoSecrets(canonical(args),secrets);
        const record=await run.callTool(name,args);s.throwIfAborted();assertNoSecrets(canonical(record),secrets);return record;
      }},s),s));
    },
    async receiptChat(input:ReceiptVisionInput,config:Omit<Parameters<typeof createReceiptChatTarget>[0],'transport'|'callTool'>,run:{callTool(name:string,args:unknown):Promise<ToolCallRecord>},signal?:AbortSignal){
      const target=createReceiptChatTarget({...config,transport:options.transport,callTool:async(name,args,s)=>{
        s?.throwIfAborted();assertNoSecrets(canonical(args),secrets);
        const record=await run.callTool(name,args);s?.throwIfAborted();assertNoSecrets(canonical(record),secrets);return record;
      }});
      if(target.configDigest!==binding.targetConfigDigest)throw new Error('media_target_configuration_conflict');
      const frozen=structuredClone(input);assertNoSecrets(canonical(frozen),secrets);
      return bounded(signal,s=>runReceiptVision(frozen,{transport:options.transport,target,targetConfigDigest:binding.targetConfigDigest,once:(key,identity,work)=>once(key,identity,work,s)},s));
    },
    async receipt(input:ReceiptVisionInput,target:ReceiptVisionPorts['target'],signal?:AbortSignal){
      const frozen=structuredClone(input);assertNoSecrets(canonical(frozen),secrets);
      return bounded(signal,s=>runReceiptVision(frozen,{transport:options.transport,target,targetConfigDigest:binding.targetConfigDigest,once:(key,identity,work)=>once(key,identity,work,s)},s));
    },
  };
}

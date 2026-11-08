import { createHash } from 'node:crypto';
import { EnvironmentSpec, SandboxScenario, SANDBOX_SPEC_VERSION } from '../../../sandbox/spec';
import type { SandboxRuntime, SandboxRun, EvalVersions, StateDiff, ToolCallRecord } from '../../../sandbox/spec';
import type { TextCheckpointStore } from '../../integration/checkpoints';
import type { SimulatorPort } from './simulator';
import type { ToolLoopTarget, TargetMessage } from './target';

/** Canonical JSON for immutable trial identity, including configuration and bounds. */
export function executionDigest(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
    throw new Error('invalid_trial_identity');
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export interface ExecutionBounds {
  maxTurns: number; maxAgentSteps: number; maxToolCalls: number; maxTranscriptBytes: number;
  timeoutMs: number; cleanupTimeoutMs: number;
  /** Reserved worst-case cap. Every external port must reserve atomically under this same trial scope. */
  budgetMicroUsd: number;
}
export interface TrialInput {
  jobId: string; trialId: string; trial: number; variant: string; seed: number;
  environment: EnvironmentSpec; scenario: SandboxScenario; versions: EvalVersions;
  agentModel: string; agentConfigDigest: string; simulatorConfigDigest: string;
  bounds: ExecutionBounds;
}
export interface TrialArtifact {
  schema: 'sandbox-execution-v1'; identityDigest: string; input: TrialInput;
  status: 'completed' | 'bounded' | 'aborted' | 'unsupported' | 'error' | 'unresolved';
  reason: string; runId: string | null; worldId: string | null;
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>;
  toolCalls: ToolCallRecord[]; diff: StateDiff[] | null; outbox: Array<Record<string, unknown>> | null;
  cleanup: { run: 'not_created' | 'attempted' | 'succeeded' | 'unknown'; world: 'not_created' | 'attempted' | 'succeeded' | 'unknown' };
  /** Execution completion is never a grading verdict. Parent grader owns passed. */
  grading: 'not_run'; money: { status: 'unknown'; microUsd: null };
  infrastructure: 'known' | 'unknown'; elapsedMs: number;
}
export interface ExecutionPorts {
  /** Trusted server budget admission. Must atomically establish this immutable trial cap;
   * all paid ports reserve under the SAME cap and retain ambiguous holds. False forbids provisioning. */
  authorizeTrial(input: { jobId: string; trialId: string; identityDigest: string; budgetMicroUsd: number }): Promise<boolean>;
  runtime: SandboxRuntime; checkpoints: TextCheckpointStore; simulator: SimulatorPort;
  target(scope: { input: TrialInput; runId: string }): ToolLoopTarget;
  /** Trusted explicit question/fact mapping, never an NLP safety assertion. Default denies when_asked facts. */
  authorizeFacts?(input: { scenario: SandboxScenario; conversation: TrialArtifact['transcript']; turn: number }): readonly number[];
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
class Stop extends Error { constructor(readonly code: string) { super(code); } }
function validate(raw: TrialInput): TrialInput {
  const input = clone(raw);
  input.environment = EnvironmentSpec.parse(input.environment); input.scenario = SandboxScenario.parse(input.scenario);
  for (const n of Object.values(input.bounds)) if (!Number.isSafeInteger(n) || n < 1) throw new Error('invalid_bounds');
  if (!Number.isSafeInteger(input.trial) || input.trial < 0 || !Number.isSafeInteger(input.seed) || input.seed < 0) throw new Error('invalid_trial');
  if (![input.jobId,input.trialId,input.variant,input.agentModel,input.agentConfigDigest,input.simulatorConfigDigest,...Object.values(input.versions)].every(x => typeof x === 'string' && x.length > 0 && x.length <= 4096)) throw new Error('missing_pin');
  if (input.versions.spec !== SANDBOX_SPEC_VERSION || input.versions.envHash !== executionDigest(input.environment)) throw new Error('environment_pin_mismatch');
  return input;
}

/** One durable, non-expiring claim fences the entire trial. No automatic replay of partial worlds. */
export async function executeToolLoopTrial(raw: TrialInput, ports: ExecutionPorts, signal?: AbortSignal): Promise<TrialArtifact> {
  const input = validate(raw), identityDigest = executionDigest(input);
  const key = { jobId: input.jobId, kind: 'sandbox_execution_trial_v1', id: input.trialId, inputDigest: identityDigest };
  if (ports.simulator.model !== input.versions.simulatorModel || ports.simulator.configDigest !== input.simulatorConfigDigest) throw new Error('simulator_pin_mismatch');
  const start = Date.now();
  const a: TrialArtifact = { schema:'sandbox-execution-v1', identityDigest,input,status:'unresolved',reason:'pending_reconciliation',runId:null,worldId:null,transcript:[],toolCalls:[],diff:null,outbox:null,cleanup:{run:'not_created',world:'not_created'},grading:'not_run',money:{status:'unknown',microUsd:null},infrastructure:'unknown',elapsedMs:0 };
  let claimTimer: ReturnType<typeof setTimeout> | undefined;
  let claim: Awaited<ReturnType<TextCheckpointStore['claim']>>;
  try {
    claim = await Promise.race([ports.checkpoints.claim(key),new Promise<never>((_,reject) => {claimTimer=setTimeout(() => reject(new Error('checkpoint_timeout')),input.bounds.timeoutMs);})]);
  } catch(e) { if(e instanceof Error && e.message === 'text_checkpoint_identity_conflict') throw new Error('trial_identity_conflict'); a.reason='checkpoint_claim_unresolved'; return a; }
  finally { clearTimeout(claimTimer); }
  if (claim.state === 'completed') {
    const saved=clone(claim.value as TrialArtifact);
    if(saved.schema !== a.schema || saved.identityDigest !== identityDigest) throw new Error('artifact_identity_conflict');
    return saved;
  }
  if (claim.state !== 'claimed') return a;
  let world: string | undefined, run: SandboxRun | undefined, expired = false;
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener('abort',abort,{once:true});
  if (signal?.aborted) abort();
  const check = () => { if (controller.signal.aborted) throw new Stop(signal?.aborted ? 'aborted' : 'deadline'); };
  const deadline = setTimeout(abort,input.bounds.timeoutMs);
  async function bounded<T>(fn: () => Promise<T>, ms?: number, ignoreAbort = false): Promise<T> {
    if (!ignoreAbort) check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: (() => void) | undefined;
    const limit = new Promise<never>((_,reject) => {
      if (ms) timer = setTimeout(() => reject(new Stop('cleanup_timeout')),ms);
      if (!ignoreAbort) { listener=() => reject(new Stop(signal?.aborted ? 'aborted' : 'deadline')); controller.signal.addEventListener('abort',listener,{once:true}); }
    });
    try { return await Promise.race([Promise.resolve().then(fn),limit]); }
    finally { if(timer) clearTimeout(timer); if(listener) controller.signal.removeEventListener('abort',listener); }
  }
  const lateCleanup = async (fn: () => Promise<void>) => { try { await bounded(fn,input.bounds.cleanupTimeoutMs,true); } catch { /* root remains unresolved; owner reconciles */ } };
  try {
    if (input.environment.integration.mode !== 'tool_loop' || input.scenario.persona.modality !== 'text' || input.scenario.attachments.length) throw new Stop('unsupported_mode_or_media');
    if (input.environment.integration.model !== input.agentModel) throw new Stop('agent_pin_mismatch');
    check();
    if (!await bounded(() => ports.authorizeTrial({jobId:input.jobId,trialId:input.trialId,identityDigest,budgetMicroUsd:input.bounds.budgetMicroUsd}))) throw new Stop('budget_denied');
    const preparation = ports.runtime.prepare(clone(input.environment),`sandbox:${identityDigest}`);
    preparation.then(v => { if(expired) void lateCleanup(() => ports.runtime.teardown(v.worldId)); },() => undefined);
    world = (await bounded(() => preparation)).worldId; a.worldId = world;
    const allocation = ports.runtime.startRun(world,clone(input.environment),clone(input.scenario),input.trial);
    allocation.then(v => { if(expired) void lateCleanup(() => v.dispose()); },() => undefined);
    run = await bounded(() => allocation); a.runId = run.runId;
    const target = ports.target({input:clone(input),runId:run.runId});
    if(target.model !== input.agentModel || target.configDigest !== input.agentConfigDigest) throw new Stop('agent_pin_mismatch');
    const messages: TargetMessage[] = input.environment.integration.systemPrompt ? [{role:'system',content:input.environment.integration.systemPrompt}] : [];
    const ids = new Set<string>(); let steps=0;
    const append = (role:'user'|'assistant',content:string) => {
      if (typeof content !== 'string') throw new Stop('invalid_content');
      a.transcript.push({role,content});
      if(Buffer.byteLength(JSON.stringify(a.transcript)) > input.bounds.maxTranscriptBytes) throw new Stop('transcript_bound');
    };
    for(let turn=0; turn<Math.min(input.bounds.maxTurns,input.scenario.persona.maxTurns);turn++) {
      const user = await bounded(() => ports.simulator.next({operationId:`${identityDigest}:simulator:${turn}`, seed:input.seed,turn,persona:clone(input.scenario.persona),conversation:clone(a.transcript),authorizedFactIndices:ports.authorizeFacts?.({scenario:clone(input.scenario),conversation:clone(a.transcript),turn}) ?? []},controller.signal));
      if (user.disposition !== 'continue') { a.status='completed'; a.reason=user.disposition; break; }
      append('user',user.content); messages.push({role:'user',content:user.content});
      for (;;) {
        if (++steps>input.bounds.maxAgentSteps) throw new Stop('agent_step_bound');
        if (Buffer.byteLength(JSON.stringify(messages)) > input.bounds.maxTranscriptBytes) throw new Stop('message_bound');
        const operationId=`${identityDigest}:target:${steps}`;
        const reply=await bounded(() => target.complete({operationId,inputDigest:executionDigest({identityDigest,messages,steps}),messages:clone(messages),signal:controller.signal}));
        append('assistant',reply.content);
        if (!reply.toolCalls.length) { messages.push({role:'assistant',content:reply.content}); break; }
        if (a.toolCalls.length+reply.toolCalls.length>input.bounds.maxToolCalls) throw new Stop('tool_call_bound');
        for(const call of reply.toolCalls) {
          if(ids.has(call.id) || !input.environment.tools.some(t=>t.name===call.name)) throw new Stop('invalid_tool_call');
          ids.add(call.id);
        }
        messages.push({role:'assistant',content:reply.content,tool_calls:reply.toolCalls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))});
        for(const call of reply.toolCalls) {
          const record=await bounded(() => run!.callTool(call.name,clone(call.args)));
          a.toolCalls.push(clone(record));
          const content=JSON.stringify(record.error ? {error:record.error} : record.result);
          if(Buffer.byteLength(content ?? '')>input.bounds.maxTranscriptBytes) throw new Stop('tool_result_bound');
          messages.push({role:'tool',tool_call_id:call.id,content:content ?? 'null'});
        }
      }
      if(turn+1===Math.min(input.bounds.maxTurns,input.scenario.persona.maxTurns)) { a.status='bounded';a.reason='turn_bound'; }
    }
    a.diff=clone(await bounded(() => run!.diff())); a.outbox=clone(await bounded(() => run!.outbox()));
    a.infrastructure='known';
  } catch(e) {
    a.reason=e instanceof Stop ? e.code : 'execution_port_error';
    a.status=a.reason==='aborted'?'aborted':a.reason.startsWith('unsupported')?'unsupported':e instanceof Stop && !a.reason.endsWith('mismatch')?'bounded':'error';
  } finally {
    expired=true; clearTimeout(deadline); controller.abort(); signal?.removeEventListener('abort',abort);
    if(run) { a.cleanup.run='attempted'; try { await bounded(() => run!.dispose(),input.bounds.cleanupTimeoutMs,true); a.cleanup.run='succeeded'; } catch { a.cleanup.run='unknown'; } }
    if(world) { a.cleanup.world='attempted'; try { await bounded(() => ports.runtime.teardown(world!),input.bounds.cleanupTimeoutMs,true);a.cleanup.world='succeeded'; } catch {a.cleanup.world='unknown';} }
    if(a.cleanup.run==='unknown'||a.cleanup.world==='unknown') a.infrastructure='unknown';
    a.elapsedMs=Date.now()-start;
  }
  try { await bounded(() => ports.checkpoints.complete(key,claim.token,clone(a)),input.bounds.cleanupTimeoutMs,true); }
  catch { await bounded(() => ports.checkpoints.markAmbiguous(key,claim.token),input.bounds.cleanupTimeoutMs,true).catch(()=>undefined); a.status='unresolved';a.reason='artifact_persistence_ambiguous'; }
  return a;
}

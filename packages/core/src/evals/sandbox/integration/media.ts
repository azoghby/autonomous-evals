import { SANDBOX_SPEC_VERSION, type SandboxRun } from '../../../sandbox/spec';
import { createMultimodalBridge, type MediaBridgeOptions, type MediaTrialBinding } from '../multimodal/bridge';
import { createReceiptChatTarget, type ReceiptVisionInput } from '../multimodal/vision';
import type { BufferedVoiceTrialInput } from '../multimodal/voice';
import { executionDigest, type ExecutionPorts, type TrialArtifact, type TrialInput } from '../execution/runner';

type ReceiptConfig = Omit<Parameters<typeof createReceiptChatTarget>[0], 'transport' | 'callTool'>;
export type EngineMediaPlan =
  | { kind: 'voice'; input: Omit<BufferedVoiceTrialInput, 'operationId'> }
  | { kind: 'receipt'; input: Omit<ReceiptVisionInput, 'operationId'>; target: ReceiptConfig };
export interface EngineMediaPorts {
  /** Pure server configuration resolver, called on every replay. No provisioning or dispatch.
   * Facts/text must be approved persona facts; functions are trusted, never customer JSON. */
  plan(input: Readonly<TrialInput>): EngineMediaPlan;
  bridge: Omit<MediaBridgeOptions, 'binding'>;
  /** Publish a durable immutable SQL snapshot, complete trajectory/diff and evidence BEFORE
   * disposal. Load it later via authority.finalSnapshot using this exact run/identity.
   * This structural seam deliberately has no dependency on runtime-bridge implementations. */
  captureFinalSnapshot(input: { execution: TrialArtifact; run: SandboxRun; binding: MediaTrialBinding }): Promise<void>;
}
export type EngineMediaEvidence =
  | { kind: 'voice'; artifact: Awaited<ReturnType<ReturnType<typeof createMultimodalBridge>['voice']>> }
  | { kind: 'receipt'; artifact: Awaited<ReturnType<ReturnType<typeof createMultimodalBridge>['receiptChat']>> };

/** Strip executable validation callback from identity; schema/config data remain pinned.
 * The trusted runtime must independently enforce schemas, tools and row authority. */
export function pinMediaPlan(plan: EngineMediaPlan): EngineMediaPlan {
  if (plan.kind === 'voice') return structuredClone(plan);
  const { validateToolArgs, ...target } = plan.target;
  return { kind: 'receipt', input: structuredClone(plan.input), target: { ...structuredClone(target), validateToolArgs } };
}
export function mediaPlanIdentity(plan: EngineMediaPlan): unknown {
  if (plan.kind === 'voice') return plan;
  const { validateToolArgs: _, ...target } = plan.target;
  return { ...plan, target };
}
export function validateMediaPlan(input: TrialInput, plan: EngineMediaPlan, ports: EngineMediaPorts): string {
  if (![input.jobId,input.trialId,input.variant,input.agentModel,input.agentConfigDigest,input.simulatorConfigDigest,...Object.values(input.versions)].every(v => typeof v === 'string' && v.length > 0 && v.length <= 4096)) throw Error('media_missing_pin');
  if (input.versions.spec !== SANDBOX_SPEC_VERSION) throw Error('media_spec_mismatch');
  if (Object.values(input.bounds).some(n => !Number.isSafeInteger(n) || n < 1)
    || !Number.isSafeInteger(input.trial) || input.trial < 0 || !Number.isSafeInteger(input.seed) || input.seed < 0)
    throw Error('media_invalid_bounds');
  const integration = input.environment.integration;
  if (integration.mode !== 'tool_loop' || integration.model !== input.agentModel) throw Error('media_mode_mismatch');
  const target = plan.kind === 'voice' ? plan.input.target : plan.target;
  const declarations = plan.kind === 'voice' ? (plan.input.target.tools ?? []).map(raw => {
    const entry = raw as { type?: string; function?: { name: string; parameters: unknown } };
    if (entry?.type !== 'function' || !entry.function) throw Error('media_tool_schema_mismatch');
    return entry.function;
  }) : plan.target.tools;
  if (new Set(declarations.map(t => t.name)).size !== declarations.length || declarations.some(t => {
    const approved = input.environment.tools.find(a => a.name === t.name);
    return !approved || executionDigest(t.parameters) !== executionDigest(approved.inputSchema);
  })) throw Error('media_tool_schema_mismatch');
  if (target.model !== input.agentModel || target.endpointUrl !== integration.endpointUrl
    || (target.systemPrompt ?? '') !== (integration.systemPrompt ?? '')) throw Error('media_target_mismatch');
  if (plan.kind === 'voice') {
    const approvedText = input.scenario.persona.knowledge.filter(f => f.revealWhen === 'upfront').map(f => f.fact).join(' ');
    if (plan.input.text !== approvedText || Object.values(plan.input.facts).some(f => !approvedText.includes(f)))
      throw Error('media_voice_facts_not_admitted');
    if (input.scenario.persona.modality !== 'voice' || input.scenario.attachments.length
      || executionDigest(plan.input.voice) !== executionDigest(input.scenario.persona.voice)
      || plan.input.maxToolCalls > input.bounds.maxToolCalls || plan.input.maxToolRounds > input.bounds.maxAgentSteps
      || plan.input.maxElapsedMs > input.bounds.timeoutMs) throw Error('media_voice_mismatch');
    return executionDigest(plan.input.target);
  }
  if (!['text', 'multimodal'].includes(input.scenario.persona.modality) || input.scenario.attachments.length !== 1
    || executionDigest(plan.input.attachment) !== executionDigest(input.scenario.attachments[0])
    || plan.input.seed !== input.seed || plan.input.targetModel !== input.agentModel
    || plan.target.maxToolCalls > input.bounds.maxToolCalls || plan.target.maxToolRounds > input.bounds.maxAgentSteps)
    throw Error('media_receipt_mismatch');
  return createReceiptChatTarget({ ...plan.target, transport: ports.bridge.transport,
    callTool: async () => { throw Error('identity_only'); } }).configDigest;
}

/** Internal lifecycle: caller MUST hold the durable whole-engine trial fence. */
export async function executeEngineMedia(input: TrialInput, plan: EngineMediaPlan, binding: MediaTrialBinding,
  ports: ExecutionPorts, media: EngineMediaPorts, signal?: AbortSignal): Promise<{ execution: TrialArtifact; media: EngineMediaEvidence | null }> {
  const start = Date.now(), identityDigest = executionDigest(input);
  const execution: TrialArtifact = { schema: 'sandbox-execution-v1', identityDigest, input: structuredClone(input),
    status: 'unresolved', reason: 'media_pending_reconciliation', runId: null, worldId: null,
    transcript: [], toolCalls: [], diff: null, outbox: null, cleanup: { run: 'not_created', world: 'not_created' },
    grading: 'not_run', money: { status: 'unknown', microUsd: null }, infrastructure: 'unknown', elapsedMs: 0 };
  let run: SandboxRun | undefined, world: string | undefined, expired = false, evidence: EngineMediaEvidence | null = null;
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, input.bounds.timeoutMs);
  async function bounded<T>(work: () => Promise<T>, cleanup = false): Promise<T> {
    const s = cleanup ? AbortSignal.timeout(input.bounds.cleanupTimeoutMs) : controller.signal;
    s.throwIfAborted();
    let stop!: () => void;
    try { return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
      stop = () => reject(Error('media_operation_ambiguous')); s.addEventListener('abort', stop, { once: true });
    })]); } finally { s.removeEventListener('abort', stop); }
  }
  const cleanupLate = (work: () => Promise<void>) => { void bounded(work, true).catch(() => {}); };
  try {
    if (!await bounded(() => ports.authorizeTrial({ jobId: input.jobId, trialId: input.trialId, identityDigest,
      budgetMicroUsd: input.bounds.budgetMicroUsd }))) throw Error('budget_denied');
    const preparation = ports.runtime.prepare(structuredClone(input.environment), `sandbox:${identityDigest}`);
    preparation.then(v => { if (expired) cleanupLate(() => ports.runtime.teardown(v.worldId)); }, () => {});
    world = (await bounded(() => preparation)).worldId; execution.worldId = world;
    const allocation = ports.runtime.startRun(world, structuredClone(input.environment), structuredClone(input.scenario), input.trial);
    allocation.then(v => { if (expired) cleanupLate(() => v.dispose()); }, () => {});
    run = await bounded(() => allocation); execution.runId = run.runId;
    const bridge = createMultimodalBridge({ ...media.bridge, binding });
    let count = 0;
    const tools = { callTool: async (name: string, args: unknown) => {
      controller.signal.throwIfAborted();
      if (++count > input.bounds.maxToolCalls || !input.environment.tools.some(t => t.name === name) || !(plan.kind === 'receipt' ? plan.target.tools.some(t => t.name === name) : (plan.input.target.tools ?? []).some(raw => (raw as { function?: { name?: string } }).function?.name === name))) throw Error('media_tool_denied');
      return run!.callTool(name, structuredClone(args));
    } };
    if (plan.kind === 'voice') {
      const artifact = await bounded(() => bridge.voice({ ...plan.input, operationId: identityDigest }, tools, controller.signal));
      evidence = { kind: 'voice', artifact };
      execution.transcript = [{ role: 'user', content: plan.input.text }, { role: 'assistant', content: artifact.reply }];
      execution.toolCalls = structuredClone(artifact.toolCalls);
    } else {
      const artifact = await bounded(() => bridge.receiptChat({ ...plan.input, operationId: identityDigest }, plan.target, tools, controller.signal));
      evidence = { kind: 'receipt', artifact };
      execution.transcript = artifact.target.transcript.filter((m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'tool');
      execution.toolCalls = structuredClone(artifact.target.toolCalls);
    }
    if (Buffer.byteLength(JSON.stringify(execution.transcript)) > input.bounds.maxTranscriptBytes) throw Error('media_transcript_bound');
    execution.diff = structuredClone(await bounded(() => run!.diff()));
    execution.outbox = structuredClone(await bounded(() => run!.outbox()));
    if (executionDigest(run.trajectory()) !== executionDigest(execution.toolCalls)) throw Error('media_trajectory_mismatch');
    execution.status = 'completed'; execution.reason = 'media_completed';
    await bounded(() => media.captureFinalSnapshot({ execution: structuredClone(execution), run: run!, binding: structuredClone(binding) }));
    execution.infrastructure = 'known';
  } catch {
    execution.status = 'unresolved'; execution.reason = 'media_execution_or_snapshot_unknown';
  } finally {
    expired = true; clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', abort);
    if (run) { execution.cleanup.run = 'attempted'; try { await bounded(() => run!.dispose(), true); execution.cleanup.run = 'succeeded'; } catch { execution.cleanup.run = 'unknown'; } }
    if (world) { execution.cleanup.world = 'attempted'; try { await bounded(() => ports.runtime.teardown(world!), true); execution.cleanup.world = 'succeeded'; } catch { execution.cleanup.world = 'unknown'; } }
    if (execution.cleanup.run === 'unknown' || execution.cleanup.world === 'unknown') execution.infrastructure = 'unknown';
    execution.elapsedMs = Date.now() - start;
  }
  return { execution, media: evidence };
}

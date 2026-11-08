import { createHash } from 'node:crypto';
import { generateSpeech, transcribe } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import type { MediaGateway } from '../../../sandbox/media/client';
import { speakAsPersona } from '../../../sandbox/media/tts';
import { transcribeAudio, wordErrorRate } from '../../../sandbox/media/stt';
import { ChatAudioVoiceDriver } from '../../../sandbox/media/voice-driver';
import { gradePerception, targetsFromSpokenFacts } from '../../../sandbox/media/perception';
import type { Persona, ToolCallRecord } from '../../../sandbox/spec';
import type { MediaTransport } from './common';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (bytes: Uint8Array): Record<string, unknown> => {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('voice_response_invalid');
  return value as Record<string, unknown>;
};
const unsupported = async (): Promise<never> => { throw new Error('unsupported_media:voice_gateway_only'); };

/** Installed Gateway v4 SDK behind Track A's MediaGateway port. No ambient
 * credentials, automatic retries, estimate-as-settlement or live model discovery. */
export function createMeteredVoiceGateway(input: {
  transport: MediaTransport; operationPrefix: string; maxAudioBytes: number; signal?: AbortSignal;
}): MediaGateway {
  let sequence = 0;
  if (!input.operationPrefix || !Number.isSafeInteger(input.maxAudioBytes) || input.maxAudioBytes < 1) throw new Error('voice_config_invalid');
  const provider = createGateway({ apiKey: 'injected-transport-only', fetch: async (url, init) => {
    input.signal?.throwIfAborted();
    const path = String(url);
    const kind = path.endsWith('/speech-model') ? 'speech' : path.endsWith('/transcription-model') ? 'transcription' : undefined;
    if (!kind) throw new Error('unsupported_media:voice_route');
    const response = await input.transport.dispatch({
      operationId: `${input.operationPrefix}:${sequence++}:${kind}`, capability: kind,
      url: path, body: init?.body ?? '', response: 'json', signal: input.signal,
      // SDK's placeholder auth must never be confused with authorization. B injects the real secret.
      headers: Object.fromEntries([...new Headers(init?.headers)].filter(([k]) => k !== 'authorization')),
    });
    return new Response(new Uint8Array(response.bytes), { status: 200, headers: { 'content-type': response.contentType } });
  } });
  return {
    vision: unsupported, image: unsupported,
    async speak(a) {
      if (!a.text.trim() || a.text.length > 4000 || a.outputFormat !== 'wav') throw new Error('unsupported_media:voice_requires_bounded_wav');
      const start = performance.now();
      const result = await generateSpeech({ model: provider.speechModel(a.model), text: a.text,
        voice: a.voice, outputFormat: 'wav', speed: a.speed, instructions: a.instructions,
        language: a.language, abortSignal: input.signal, maxRetries: 0 });
      if (result.warnings?.length) throw new Error('voice_provider_warning');
      const audio = result.audio.uint8Array;
      validateWav(audio, input.maxAudioBytes);
      // Legacy numeric field is deliberately unused. B transport owns money; trial cost is unknown.
      return { audio, mediaType: 'audio/wav', format: 'wav', microUsd: 0,
        latencyMs: performance.now() - start, model: a.model, warnings: [] };
    },
    async transcribe(a) {
      validateWav(a.audio, input.maxAudioBytes);
      const start = performance.now();
      const result = await transcribe({ model: provider.transcriptionModel(a.model), audio: a.audio,
        abortSignal: input.signal, maxRetries: 0 });
      if (result.warnings?.length) throw new Error('voice_provider_warning');
      if (!result.text.trim() || result.text.length > 16000) throw new Error('voice_transcript_invalid');
      return { text: result.text, microUsd: 0, latencyMs: performance.now() - start, model: a.model, warnings: [] };
    },
  };
}

function validateWav(audio: Uint8Array, maxBytes: number): void {
  if (audio.byteLength < 44 || audio.byteLength > maxBytes || Buffer.from(audio.subarray(0, 4)).toString() !== 'RIFF'
    || Buffer.from(audio.subarray(8, 12)).toString() !== 'WAVE') throw new Error('voice_wav_invalid');
}

export interface BufferedVoiceTrialInput {
  operationId: string; text: string; facts: Record<string, string>;
  voice: NonNullable<Persona['voice']>; sttModel: string;
  target: { endpointUrl: string; model: string; tools?: unknown[]; systemPrompt?: string };
  maxAudioBytes: number; maxToolRounds: number; maxToolCalls: number; maxElapsedMs: number;
  maxInputWer: number; latencyBudgetMs?: number;
}
/** Single bounded buffered turn. The actual A driver performs protocol serialization, and
 * actual tool execution is delegated only to a trusted run-scoped executor. The caller must
 * fence this whole trial before tools, as per the B execution bridge. Not realtime/barge-in. */
export async function runBufferedVoiceTrial(input: BufferedVoiceTrialInput, ports: {
  transport: MediaTransport;
  callTool(name: string, args: unknown): Promise<ToolCallRecord>;
}, signal?: AbortSignal) {
  if (!input.operationId || !input.text.trim() || input.text.length > 4000 || !Object.keys(input.facts).length
    || Object.values(input.facts).some(v => !v.trim() || !input.text.includes(v))
    || input.voice.interrupts || !input.voice.ttsModel || !input.sttModel || input.sttModel === input.target.model
    || !Number.isSafeInteger(input.maxAudioBytes) || input.maxAudioBytes < 44 || input.maxAudioBytes > 10000000
    || !Number.isSafeInteger(input.maxToolRounds) || input.maxToolRounds < 0 || input.maxToolRounds > 20
    || !Number.isSafeInteger(input.maxToolCalls) || input.maxToolCalls < 0 || input.maxToolCalls > 100
    || !Number.isFinite(input.maxInputWer) || input.maxInputWer < 0 || input.maxInputWer > 1
    || !Number.isSafeInteger(input.maxElapsedMs) || input.maxElapsedMs < 1 || input.maxElapsedMs > 300000
    || (input.latencyBudgetMs !== undefined && (!Number.isFinite(input.latencyBudgetMs) || input.latencyBudgetMs < 0))) throw new Error('voice_trial_invalid_or_unsupported');
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(input.maxElapsedMs)]) : AbortSignal.timeout(input.maxElapsedMs);
  const start = performance.now();
  const gateway = createMeteredVoiceGateway({ transport: ports.transport, operationPrefix: input.operationId, maxAudioBytes: input.maxAudioBytes, signal: combined });
  const spoken = await speakAsPersona(gateway, input.text, input.voice, { outputFormat: 'wav' });
  // Only bytes, MIME and pinned STT model reach the oracle; never expected text/facts.
  const oracle = await transcribeAudio(gateway, spoken.audio, { model: input.sttModel, mediaType: spoken.mediaType });
  const wer = wordErrorRate(input.text, oracle.text);
  if (wer > input.maxInputWer || Object.values(input.facts).some(v => !oracle.text.includes(v))) throw new Error('voice_ground_truth_mismatch');
  let request = 0;
  const driver = new ChatAudioVoiceDriver({ ...input.target, wantAudio: true, outputFormat: 'wav', timeoutMs: input.maxElapsedMs,
    fetchImpl: async (url, init) => {
      combined.throwIfAborted();
      const r = await ports.transport.dispatch({ operationId: `${input.operationId}:target:${request++}`, capability: 'audio-agent',
        url: String(url), body: JSON.stringify({ ...JSON.parse(String(init?.body)), max_completion_tokens: 1000, parallel_tool_calls: false, store: false }), headers: { 'content-type': 'application/json' }, response: 'json', signal: combined });
      const value = json(r.bytes);
      const choices = value.choices;
      if (!Array.isArray(choices) || choices.length !== 1) throw new Error('voice_agent_choices_invalid');
      const message = (choices[0] as { message?: Record<string, unknown> })?.message;
      if (!message || (message.tool_calls !== undefined && !Array.isArray(message.tool_calls))) throw new Error('voice_agent_message_invalid');
      if (Array.isArray(message.tool_calls) && message.tool_calls.some(c => !c || typeof c.id !== 'string' || typeof c.function?.name !== 'string' || typeof c.function?.arguments !== 'string')) throw new Error('voice_agent_tool_invalid');
      return new Response(new Uint8Array(r.bytes), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  let reply = await driver.sendUserAudio(spoken.audio, 'wav', 0);
  const timings = [reply.timing], calls: ToolCallRecord[] = [], ids = new Set<string>();
  let round = 0;
  while (reply.toolCalls.length) {
    combined.throwIfAborted();
    if (round++ >= input.maxToolRounds || calls.length + reply.toolCalls.length > input.maxToolCalls) throw new Error('voice_tool_bound');
    const results: Array<{ toolCallId: string; content: string }> = [];
    for (const call of reply.toolCalls) {
      if (!call.id || ids.has(call.id)) throw new Error('voice_duplicate_tool');
      ids.add(call.id);
      const args: unknown = JSON.parse(call.arguments);
      combined.throwIfAborted();
      // The unchanged A tool contract cannot cancel an in-flight operation. Reject on deadline;
      // the durable whole-trial pending fence must retain this ambiguity, never retry the tool.
      const record = await new Promise<ToolCallRecord>((resolve, reject) => {
        const abort = () => reject(new Error('voice_tool_abort_ambiguous'));
        combined.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => { combined.throwIfAborted(); return ports.callTool(call.name, args); })
          .then(resolve, () => reject(new Error('voice_tool_failed_ambiguous')))
          .finally(() => combined.removeEventListener('abort', abort));
      });
      combined.throwIfAborted();
      if (record.tool !== call.name || JSON.stringify(record.args) !== JSON.stringify(args)) throw new Error('voice_tool_evidence_mismatch');
      calls.push(record);
      results.push({ toolCallId: call.id, content: JSON.stringify(record.error ? { error: record.error } : record.result) });
    }
    reply = await driver.sendToolResults(results, round);
    timings.push(reply.timing);
  }
  if (!reply.agentAudio || reply.agentAudio.format !== 'wav') throw new Error('unsupported_media:agent_audio_missing');
  validateWav(reply.agentAudio.bytes, input.maxAudioBytes);
  // Always independently STT reply bytes, even when target asserts its own transcript/content.
  const heard = await transcribeAudio(gateway, reply.agentAudio.bytes, { model: input.sttModel, mediaType: 'audio/wav' });
  combined.throwIfAborted();
  const perception = gradePerception({ targets: targetsFromSpokenFacts(input.facts), toolCalls: calls,
    transcript: [{ role: 'assistant', content: heard.text }] });
  const elapsedMs = performance.now() - start;
  return { inputAudioSha256: digest(spoken.audio), replyAudioSha256: digest(reply.agentAudio.bytes),
    oracle: { text: oracle.text, model: input.sttModel, assetSha256: digest(spoken.audio), wer },
    reply: heard.text, toolCalls: calls, perception,
    timing: { elapsedMs, turns: timings, ttfaMeasurement: 'whole_response_upper_bound' as const,
      latencyPassed: input.latencyBudgetMs === undefined ? null : elapsedMs <= input.latencyBudgetMs },
    models: { tts: input.voice.ttsModel, stt: input.sttModel, target: input.target.model },
    cost: { status: 'unknown' as const, microUsd: null }, mode: 'buffered_chat_audio' as const };
}

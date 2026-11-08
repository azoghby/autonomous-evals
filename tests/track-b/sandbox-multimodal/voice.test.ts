import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeteredVoiceGateway, runBufferedVoiceTrial, type BufferedVoiceTrialInput } from '../../../packages/core/src/evals/sandbox/multimodal/voice';
import type { MediaTransport } from '../../../packages/core/src/evals/sandbox/multimodal/common';
const wav = () => { const b = Buffer.alloc(48); b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVE', 8); b.write('fmt ',12); b.writeUInt32LE(16,16); b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(16000,24); b.writeUInt32LE(32000,28); b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(4,40); return b; };
const input = (): BufferedVoiceTrialInput => ({ operationId: 'voice-1', text: 'Order 12345 please', facts: { order: '12345' },
  voice: { ttsModel: 'openai/tts-1', voiceId: 'alloy', pace: 'normal', interrupts: false }, sttModel: 'openai/whisper-1',
  target: { endpointUrl: 'https://customer.example/v1/chat/completions', model: 'configured-audio-model' },
  maxAudioBytes: 10000, maxToolRounds: 2, maxToolCalls: 3, maxElapsedMs: 3000, maxInputWer: 0 });
function fixture(options: { oracle?: string; malformed?: boolean; noAudio?: boolean; duplicate?: boolean } = {}) {
  const requests: Array<{ url: string; body: Record<string, unknown>; headers?: Record<string,string> }> = [];
  let stt = 0, target = 0;
  const transport: MediaTransport = { async dispatch(r) {
    const body = JSON.parse(String(r.body)); requests.push({ url: r.url, body, headers: r.headers });
    let value: unknown;
    if (r.url.endsWith('speech-model')) value = { audio: wav().toString('base64') };
    else if (r.url.endsWith('transcription-model')) value = { text: stt++ === 0 ? options.oracle ?? input().text : 'I found your order 12345' };
    else value = { choices: [{ message: target++ === 0 ? { tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{"order":"12345"}' } },
      ...(options.duplicate ? [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] : [])
    ] } : { content: 'FAKE TARGET TRANSCRIPT', ...(options.noAudio ? {} : { audio: { data: wav().toString('base64'), transcript: 'SELF ASSERTED WRONG' } }) } }] };
    return { bytes: new TextEncoder().encode(options.malformed ? '{}' : JSON.stringify(value)), contentType: 'application/json', elapsedMs: 2, responseDigest: 'a'.repeat(64) };
  } };
  const calls: unknown[] = [];
  const callTool = async (name: string, args: unknown) => { calls.push(args); return { seq: calls.length, tool: name, args, result: { found: true }, ms: 1 }; };
  return { requests, calls, transport, callTool };
}

test('A voice helpers and actual SDK/ChatAudio serializers execute audio -> tool -> reply STT with provenance', async () => {
  const f = fixture(); const result = await runBufferedVoiceTrial(input(), f);
  assert.equal(result.reply, 'I found your order 12345');
  assert.equal(result.perception[0]?.passed, true);
  assert.equal(result.inputAudioSha256, result.oracle.assetSha256);
  assert.equal(result.timing.ttfaMeasurement, 'whole_response_upper_bound');
  assert.deepEqual(result.cost, { status: 'unknown', microUsd: null });
  assert.equal(f.requests.length, 5);
  const speech = f.requests[0]!;
  assert.equal(speech.url, 'https://ai-gateway.vercel.sh/v4/ai/speech-model');
  assert.equal(speech.headers?.['ai-speech-model-specification-version'], '4');
  assert.equal(speech.headers?.authorization, undefined);
  assert.equal(speech.body.text, input().text);
  const oracle = f.requests[1]!;
  assert.deepEqual(Object.keys(oracle.body).filter(k => k !== 'providerOptions').sort(), ['audio','mediaType']);
  assert.equal(JSON.stringify(oracle.body.providerOptions ?? {}).includes('12345'), false);
  assert.equal(oracle.body.audio, wav().toString('base64'));
  assert.equal(JSON.stringify(f.requests[2]?.body).includes('input_audio'), true);
  assert.equal(f.requests[2]?.body.max_completion_tokens,1000);
  assert.equal(f.requests[2]?.body.parallel_tool_calls,false);
  assert.equal(JSON.stringify(f.requests[3]?.body).includes('tool_call_id'), true);
  assert.equal(result.models.tts, 'openai/tts-1');
});

test('independent STT disagreement prevents agent dispatch and tool execution', async () => {
  const f = fixture({ oracle: 'Order 98765 please' });
  await assert.rejects(runBufferedVoiceTrial(input(), f), /ground_truth/);
  assert.equal(f.requests.length, 2); assert.equal(f.calls.length, 0);
});

test('missing target audio is explicitly unsupported despite claimed text', async () => {
  const f = fixture({ noAudio: true });
  await assert.rejects(runBufferedVoiceTrial(input(), f), /unsupported_media:agent_audio_missing/);
});

test('malformed provider response rejects through SDK parser without retries', async () => {
  const f = fixture({ malformed: true });
  const gw = createMeteredVoiceGateway({ transport: f.transport, operationPrefix: 'bad', maxAudioBytes: 10000 });
  await assert.rejects(gw.speak({ model:'openai/tts-1', text:'test', outputFormat:'wav' }));
  assert.equal(f.requests.length, 1);
});

test('bounded tools and duplicate calls stop before duplicate execution', async () => {
  const f = fixture({ duplicate: true });
  await assert.rejects(runBufferedVoiceTrial(input(), f), /duplicate_tool/);
  assert.equal(f.calls.length, 1);
  const g = fixture(); await assert.rejects(runBufferedVoiceTrial({ ...input(), maxToolCalls: 0 }, g), /voice_tool_bound/);
  assert.equal(g.calls.length, 0);
});

test('barge-in explicitly unsupported and pre-abort blocks dispatch', async () => {
  const f = fixture(); await assert.rejects(runBufferedVoiceTrial({ ...input(), voice: { ...input().voice, interrupts: true } }, f), /unsupported/);
  const ac = new AbortController(); ac.abort();
  await assert.rejects(runBufferedVoiceTrial(input(), f, ac.signal)); assert.equal(f.requests.length, 0);
});

test('uncooperative world tool is bounded and marked ambiguous without a follow-up dispatch', async () => {
  const f = fixture();
  // Keep node alive while AbortSignal.timeout's unref timer is the only bound.
  const timer = setTimeout(() => {}, 500);
  try {
    await assert.rejects(runBufferedVoiceTrial({ ...input(), maxElapsedMs: 30 }, {
      transport: f.transport, callTool: () => new Promise(() => {}),
    }), /voice_tool_abort_ambiguous/);
    assert.equal(f.requests.length, 3);
  } finally { clearTimeout(timer); }
});

test('oracle cannot share target model identity', async () => {
  const f = fixture();
  await assert.rejects(runBufferedVoiceTrial({ ...input(), sttModel: input().target.model }, f), /unsupported/);
  assert.equal(f.requests.length, 0);
});

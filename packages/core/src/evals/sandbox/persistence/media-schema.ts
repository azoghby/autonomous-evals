import { z } from 'zod';
import { executionDigest } from '../execution/runner';
import { freezeSandboxInputs } from '../identity';
import type { PrivateSandboxReport } from '../integration';
import { gradePerception, targetsFromAttachments } from '../../../sandbox/media/perception';
import { planInjection } from '../../../sandbox/media/oracle';
import { valuesMatch } from '../../../sandbox/media/match';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(16000);
const ms = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = z.object({ status: z.literal('unknown'), microUsd: z.null() }).strict();
const check = z.object({ id: text, kind: z.enum(['perception', 'latency']), passed: z.boolean(),
  severity: z.enum(['critical', 'high', 'medium', 'low']), detail: z.string() }).strict();
const stats = z.object({ p50: ms, p95: ms, max: ms }).strict().refine(s => s.p50 <= s.p95 && s.p95 <= s.max);
const timing = z.object({ turn: count, userEndMs: ms, agentFirstAudioMs: ms.optional(),
  agentFirstTokenMs: ms.optional(), agentEndMs: ms.optional() }).strict();

/** Every media container is explicit/strict. Only tool args/results are opaque JSON,
 * just as in execution evidence; the persistence boundary screens their exact JSON. */
export function mediaEvidenceSchema(tools: z.ZodType, transcript: z.ZodType) {
  return z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('receipt'), artifact: z.object({ identityDigest: hash,
      provenance: z.object({ trackARef: z.literal('fc45714'), source: z.literal('render'), template: z.literal('receipt'),
        assetSha256: hash, bytes: count.min(8).max(10000000), oracleModel: text, targetModel: text,
        targetConfigDigest: hash, oracleOperationId: text, targetOperationId: text }).strict(),
      oracle: z.object({ accepted: z.literal(true), fields: z.array(z.object({ key: text, expected: text,
        read: text, matched: z.literal(true) }).strict()).min(1).max(20),
        injection: z.object({ canary: text, visible: z.boolean() }).strict().optional() }).strict(),
      perception: z.array(check), latency: z.object({ stats: z.object({ turns: count, ttfaMs: stats.nullable(), turnLatencyMs: stats.nullable() }).strict(), checks: z.array(check) }).strict(),
      cost: money, target: z.object({ deliveredAssetSha256: hash, model: text, toolCalls: tools,
        transcript, elapsedMs: ms }).strict(),
    }).strict() }).strict(),
    z.object({ kind: z.literal('voice'), artifact: z.object({ inputAudioSha256: hash, replyAudioSha256: hash,
      oracle: z.object({ text, model: text, assetSha256: hash, wer: ms.max(1) }).strict(), reply: text,
      toolCalls: tools, perception: z.array(check), timing: z.object({ elapsedMs: ms, turns: z.array(timing),
        ttfaMeasurement: z.literal('whole_response_upper_bound'), latencyPassed: z.boolean().nullable() }).strict(),
      models: z.object({ tts: text, stt: text, target: text }).strict(), cost: money,
      mode: z.literal('buffered_chat_audio'),
    }).strict() }).strict(),
  ]).nullable().optional();
}
const same = (a: unknown, b: unknown) => executionDigest(a) === executionDigest(b);
export function validateMediaBindings(r: PrivateSandboxReport): void {
  if (!r.media) {
    const s = r.execution.input.scenario;
    if (r.execution.status === 'completed' && (s.persona.modality !== 'text' || s.attachments.length))
      throw Error('sandbox_persistence_media_evidence_missing');
    return;
  }
  const e = r.execution, i = e.input, s = i.scenario;
  const fail = () => { throw Error('sandbox_persistence_media_identity_conflict'); };
  // Bind the additional deterministic outcome pins for reports with media. Legacy
  // v1 text reports retain their historic (less constrained) outcome pin format.
  if (r.outcome.fixtureHash !== executionDigest({ environment: freezeSandboxInputs(i.environment, [s]).envHash, fixtureSql: s.fixtureSql })
    || r.outcome.agentVersion !== executionDigest({ model: i.agentModel, config: i.agentConfigDigest })) fail();
  if (r.media.kind === 'receipt') {
    const a = r.media.artifact, p = a.provenance, attachment = s.attachments[0];
    if (!attachment || s.attachments.length !== 1 || !['text', 'multimodal'].includes(s.persona.modality)
      || attachment.source !== 'render' || attachment.kind !== 'image' || attachment.prompt !== 'template:receipt'
      || attachment.perturbations.length || p.targetConfigDigest !== i.agentConfigDigest
      || p.targetModel !== i.agentModel || a.target.model !== i.agentModel || p.oracleModel === i.agentModel
      || p.assetSha256 !== a.target.deliveredAssetSha256
      || p.oracleOperationId !== `${e.identityDigest}:oracle` || p.targetOperationId !== `${e.identityDigest}:target`
      || !same(a.target.toolCalls, e.toolCalls)
      || !same(a.target.transcript.filter(t => t.role !== 'tool'), e.transcript)) fail();
    const fields = Object.entries(attachment.groundTruth);
    if (fields.length !== a.oracle.fields.length || fields.some(([key, expected], n) => {
      const f = a.oracle.fields[n]; return f.key !== key || f.expected !== expected || !valuesMatch(expected, f.read);
    })) fail();
    const injection = attachment.injection ? planInjection(attachment) : undefined;
    if (injection ? a.oracle.injection?.canary !== injection.canary || a.oracle.injection.visible !== true : a.oracle.injection !== undefined) fail();
    if (!same(a.perception, gradePerception({ targets: targetsFromAttachments(s.attachments), toolCalls: e.toolCalls, transcript: a.target.transcript }))
      || a.latency.stats.turns !== 1 || a.latency.stats.ttfaMs !== null
      || !same(a.latency.stats.turnLatencyMs, { p50: a.target.elapsedMs, p95: a.target.elapsedMs, max: a.target.elapsedMs })
      || a.perception.some(c => c.kind !== 'perception') || a.latency.checks.some(c => c.kind !== 'latency')) fail();
  } else {
    const a = r.media.artifact;
    const spoken = s.persona.knowledge.filter(f => f.revealWhen === 'upfront').map(f => f.fact).join(' ');
    if (s.persona.modality !== 'voice' || s.attachments.length || a.models.target !== i.agentModel
      || a.models.stt !== a.oracle.model || a.models.stt === a.models.target || a.models.tts !== s.persona.voice?.ttsModel
      || a.oracle.assetSha256 !== a.inputAudioSha256 || !same(a.toolCalls, e.toolCalls)
      || !same(e.transcript, [{ role: 'user', content: spoken }, { role: 'assistant', content: a.reply }])
      || a.perception.some(c => c.kind !== 'perception')) fail();
  }
}

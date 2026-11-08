import type { MediaAttachment, Persona } from '../../../sandbox/spec';

export type SupportedMediaKind = 'image' | 'document' | 'audio';
/** An opaque, scoped asset reference. Port implementations own private storage and signed delivery;
 * these values are never permission to fetch arbitrary URLs from scenario data. */
export interface TrialMediaAsset {
  attachmentId: string;
  kind: SupportedMediaKind;
  mimeType: 'image/png' | 'image/jpeg' | 'application/pdf' | 'audio/wav' | 'audio/mpeg';
  sha256: string;
  bytes: number;
  assetRef: string;
}
export interface MediaOracleEvidence {
  model: string;
  configDigest: string;
  assetSha256: string;
  /** Actual independently read facts, not an echo of expected ground truth. */
  observedFacts: Record<string, string>;
  operationId: string;
}
export interface TrialMediaPort {
  readonly supportedKinds: readonly SupportedMediaKind[];
  /** Must account/fence external generation before dispatch. Apply requested perturbations before
   * computing the asset digest. Reject unsupported source/perturbations rather than ignoring them. */
  prepare(input: { trialId: string; operationId: string; seed: number; attachment: MediaAttachment }, signal?: AbortSignal): Promise<TrialMediaAsset>;
  /** Vision/STT oracle reads the produced asset, with expected ground truth intentionally omitted. */
  perceive(input: { trialId: string; operationId: string; asset: TrialMediaAsset }, signal?: AbortSignal): Promise<MediaOracleEvidence>;
  /** Idempotent cleanup including partially generated assets for this trial. */
  dispose(trialId: string): Promise<void>;
}
export interface AcceptedTrialMedia { asset: TrialMediaAsset; oracle: MediaOracleEvidence; expectedFacts: Record<string, string> }
export interface VoiceTurnPort {
  readonly model: string;
  readonly configDigest: string;
  /** TTS only. Realtime, barge-in, packet timing and turn-taking require a separate transport. */
  synthesize(input: { trialId: string; operationId: string; text: string; voice: NonNullable<Persona['voice']>; seed: number }, signal?: AbortSignal): Promise<TrialMediaAsset>;
  transcribe(input: { trialId: string; operationId: string; asset: TrialMediaAsset }, signal?: AbortSignal): Promise<{ text: string; evidence: MediaOracleEvidence }>;
}
export class UnsupportedMediaError extends Error {
  constructor(public readonly reason: string) { super(`unsupported_media:${reason}`); }
}
/** Produces useful media receipts for target/perception adapters without claiming the text runner
 * can deliver binary input. Caller owns finally-dispose; failed preparation may still allocate assets. */
export async function prepareTrialMedia(input: {
  trialId: string; seed: number; attachments: readonly MediaAttachment[];
  maxBytes: number; oracleModel: string; oracleConfigDigest: string;
}, port: TrialMediaPort, signal?: AbortSignal): Promise<AcceptedTrialMedia[]> {
  if (!input.trialId || !Number.isSafeInteger(input.seed) || input.seed < 0 || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1
    || !input.oracleModel || !/^[a-f0-9]{64}$/.test(input.oracleConfigDigest) || input.attachments.length > 8) throw new Error('media_input_invalid');
  const result: AcceptedTrialMedia[] = [], ids = new Set<string>();
  let bytes = 0;
  for (const attachment of input.attachments) {
    signal?.throwIfAborted();
    if (ids.has(attachment.id)) throw new Error('media_duplicate_attachment');
    ids.add(attachment.id);
    if (attachment.kind === 'video' || !port.supportedKinds.includes(attachment.kind)) throw new UnsupportedMediaError(attachment.kind);
    const asset = await port.prepare({ trialId: input.trialId, operationId: `${input.trialId}:media:${attachment.id}:prepare`, seed: input.seed, attachment: structuredClone(attachment) }, signal);
    signal?.throwIfAborted();
    if (asset.attachmentId !== attachment.id || asset.kind !== attachment.kind || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || !asset.assetRef || asset.assetRef.length > 4096) throw new Error('media_asset_invalid');
    const allowedMime = asset.kind === 'image' ? ['image/png', 'image/jpeg'] : asset.kind === 'document' ? ['application/pdf'] : ['audio/wav', 'audio/mpeg'];
    if (!allowedMime.includes(asset.mimeType)) throw new Error('media_mime_invalid');
    bytes += asset.bytes;
    if (!Number.isSafeInteger(bytes) || bytes > input.maxBytes) throw new Error('media_budget_exceeded');
    const oracle = await port.perceive({ trialId: input.trialId, operationId: `${input.trialId}:media:${attachment.id}:oracle`, asset: { ...asset } }, signal);
    signal?.throwIfAborted();
    if (oracle.assetSha256 !== asset.sha256 || oracle.model !== input.oracleModel || oracle.configDigest !== input.oracleConfigDigest
      || oracle.operationId !== `${input.trialId}:media:${attachment.id}:oracle`) throw new Error('media_oracle_identity_mismatch');
    if (Object.entries(attachment.groundTruth).some(([key, value]) => oracle.observedFacts[key] !== value)) throw new Error('media_oracle_ground_truth_mismatch');
    // No ground truth means no factual media acceptance evidence, even if rendering succeeded.
    if (Object.keys(attachment.groundTruth).length === 0) throw new Error('media_ground_truth_missing');
    result.push({ asset: structuredClone(asset), oracle: structuredClone(oracle), expectedFacts: { ...attachment.groundTruth } });
  }
  return result;
}

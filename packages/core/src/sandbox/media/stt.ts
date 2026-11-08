/** Transcription of agent audio (and TTS round-trip checks) + word error rate. */
import type { MediaGateway, TranscribeResult } from "./client";
import { MEDIA_MODELS } from "./models";

export async function transcribeAudio(
  gw: MediaGateway,
  audio: Uint8Array,
  opts: { model?: string; mediaType?: string } = {},
): Promise<TranscribeResult> {
  if (audio.byteLength === 0) throw new Error("transcribeAudio: empty audio");
  return gw.transcribe({ model: opts.model ?? MEDIA_MODELS.stt.primary, audio, mediaType: opts.mediaType });
}

/** Tokenize for WER: lowercase, strip punctuation (keep in-number dots/apostrophes), split on whitespace. */
export function werTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/(?<!\d)[.,]|[.,](?!\d)|[!?;:"“”()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Word error rate = (S + D + I) / N via Levenshtein over word tokens. 0 = perfect. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const r = werTokens(reference);
  const h = werTokens(hypothesis);
  if (r.length === 0) return h.length === 0 ? 0 : 1;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      const sub = prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1);
      cur.push(Math.min(sub, prev[j]! + 1, cur[j - 1]! + 1));
    }
    prev = cur;
  }
  return prev[h.length]! / r.length;
}

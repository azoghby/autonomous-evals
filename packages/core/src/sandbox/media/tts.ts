/**
 * Persona voice → audio. Simulated-user speech for voice scenarios (plan §7).
 * Pace maps to the SDK `speed` option; accent/hesitation go into `instructions` (honoured by instruction-capable
 * models such as google/gemini-3.8-flash-tts; others return an SDK warning, which we surface).
 */
import type { Persona } from "../spec";
import type { MediaGateway, SpeakResult } from "./client";
import { MEDIA_MODELS, PACE_SPEED } from "./models";

export type PersonaVoice = NonNullable<Persona["voice"]>;

export interface SpokenUtterance extends SpeakResult {
  text: string;
  /** Rough duration estimate when the provider gives none (≈ 150 wpm scaled by speed). */
  estDurationSec: number;
}

export function voiceInstructions(voice: Partial<PersonaVoice>): string | undefined {
  const parts: string[] = [];
  if (voice.accent) parts.push(`Speak with a natural ${voice.accent} accent.`);
  if (voice.pace === "slow") parts.push("Speak slowly and deliberately.");
  if (voice.pace === "fast") parts.push("Speak quickly, like someone in a hurry.");
  return parts.length ? parts.join(" ") : undefined;
}

export function estimateSpeechSeconds(text: string, speed = 1): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.round(((words / 150) * 60 * 10) / speed) / 10;
}

/** Synthesize one simulated-user utterance. `voice` is the persona's voice block (ttsModel defaults to MEDIA_MODELS.tts.primary). */
export async function speakAsPersona(
  gw: MediaGateway,
  text: string,
  voice: Partial<PersonaVoice> = {},
  opts: { outputFormat?: "mp3" | "wav"; language?: string } = {},
): Promise<SpokenUtterance> {
  if (!text.trim()) throw new Error("speakAsPersona: empty text");
  const speed = PACE_SPEED[voice.pace ?? "normal"];
  const res = await gw.speak({
    model: voice.ttsModel ?? MEDIA_MODELS.tts.primary,
    text,
    voice: voice.voiceId,
    speed: speed === 1 ? undefined : speed,
    instructions: voiceInstructions(voice),
    outputFormat: opts.outputFormat,
    language: opts.language,
  });
  return { ...res, text, estDurationSec: estimateSpeechSeconds(text, speed) };
}

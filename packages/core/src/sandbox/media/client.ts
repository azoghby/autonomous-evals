/**
 * Thin, injectable media client over the Vercel AI Gateway (AI SDK v7 + @ai-sdk/gateway v4).
 * Every media module takes a `MediaGateway` so tests can pass a fake.
 *
 * APIs used (verified in node_modules/ai@7.0.165 docs + @ai-sdk/gateway@4.0.138 typings):
 *   generateSpeech({ model: gateway.speechModel(id), text, voice, speed, instructions, outputFormat })
 *   transcribe({ model: gateway.transcriptionModel(id), audio })
 *   generateImage({ model: gateway.imageModel(id), prompt, size | aspectRatio, seed })
 *   generateText({ model: gateway(id), messages: [{ role:"user", content:[text, {type:"file", mediaType, data}] }] })
 */
import { generateImage, generateSpeech, generateText, transcribe } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import type { GatewayContext } from "../../ai/gateway";
import { MEDIA_LIST_PRICES } from "./models";

export interface VisionArgs { model: string; image: Uint8Array; mediaType: string; prompt: string; system?: string; maxOutputTokens?: number }
export interface SpeakArgs { model: string; text: string; voice?: string; speed?: number; instructions?: string; outputFormat?: string; language?: string }
export interface TranscribeArgs { model: string; audio: Uint8Array; mediaType?: string }
export interface ImageArgs { model: string; prompt: string; size?: `${number}x${number}`; aspectRatio?: `${number}:${number}`; seed?: number }

interface Billed { microUsd: number; latencyMs: number; model: string; warnings: string[] }
export interface VisionResult extends Billed { text: string }
export interface SpeakResult extends Billed { audio: Uint8Array; mediaType: string; format: string }
export interface TranscribeResult extends Billed { text: string; durationSec?: number; words?: Array<{ text: string; startSecond: number; endSecond: number }> }
export interface ImageResult extends Billed { image: Uint8Array; mediaType: string }

export interface MediaGateway {
  vision(args: VisionArgs): Promise<VisionResult>;
  speak(args: SpeakArgs): Promise<SpeakResult>;
  transcribe(args: TranscribeArgs): Promise<TranscribeResult>;
  image(args: ImageArgs): Promise<ImageResult>;
}

const DEFAULT_TIMEOUT_MS = 90_000;

function gatewayCost(providerMetadata: unknown): number | undefined {
  const gw = (providerMetadata as { gateway?: { cost?: string | number; marketCost?: string | number } } | undefined)?.gateway;
  const raw = gw?.cost ?? gw?.marketCost;
  const n = typeof raw === "string" ? Number.parseFloat(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

const toMicro = (usd: number): number => Math.max(0, Math.round(usd * 1_000_000));
const warn = (ws: unknown[] | undefined): string[] => (ws ?? []).map((w) => JSON.stringify(w).slice(0, 200));

export interface MediaClientOptions { ctx?: GatewayContext; apiKey?: string; timeoutMs?: number }

/** Real client. Records each call's cost through ctx.recordCost (source "ai_gateway") when a ctx is given. */
export function createGatewayMediaClient(opts: MediaClientOptions = {}): MediaGateway {
  const key = opts.apiKey ?? process.env.AI_GATEWAY_API_KEY;
  const gateway = key ? createGateway({ apiKey: key }) : createGateway();
  const timeout = () => AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  async function bill(kind: string, model: string, usd: number | undefined, estimateUsd: number): Promise<number> {
    const microUsd = toMicro(usd ?? estimateUsd);
    await opts.ctx?.recordCost({
      source: "ai_gateway",
      microUsd,
      meta: { provider: "vercel", model, media: kind, costBasis: usd === undefined ? "list_price_estimate" : "gateway_reported" },
    });
    return microUsd;
  }

  return {
    async vision(a) {
      const t0 = Date.now();
      const res = await generateText({
        model: gateway(a.model),
        system: a.system,
        messages: [{ role: "user", content: [{ type: "text", text: a.prompt }, { type: "file", mediaType: a.mediaType, data: a.image }] }],
        maxOutputTokens: a.maxOutputTokens ?? 1_000,
        temperature: 0,
        abortSignal: timeout(),
        maxRetries: 1,
      });
      const p = MEDIA_LIST_PRICES[a.model];
      const est = ((res.usage?.inputTokens ?? 0) * (p?.inputPerMTok ?? 2) + (res.usage?.outputTokens ?? 0) * (p?.outputPerMTok ?? 10)) / 1e6;
      const microUsd = await bill("vision", a.model, gatewayCost(res.providerMetadata), est);
      return { text: res.text, microUsd, latencyMs: Date.now() - t0, model: a.model, warnings: warn(res.warnings) };
    },

    async speak(a) {
      const t0 = Date.now();
      const res = await generateSpeech({
        model: gateway.speechModel(a.model),
        text: a.text,
        voice: a.voice,
        speed: a.speed,
        instructions: a.instructions,
        outputFormat: a.outputFormat,
        language: a.language,
        abortSignal: timeout(),
        maxRetries: 1,
      });
      const est = a.text.length * (MEDIA_LIST_PRICES[a.model]?.perChar ?? 0.00004);
      const microUsd = await bill("tts", a.model, gatewayCost(res.providerMetadata), est);
      return { audio: res.audio.uint8Array, mediaType: res.audio.mediaType, format: res.audio.format, microUsd, latencyMs: Date.now() - t0, model: a.model, warnings: warn(res.warnings) };
    },

    async transcribe(a) {
      const t0 = Date.now();
      const res = await transcribe({ model: gateway.transcriptionModel(a.model), audio: a.audio, abortSignal: timeout(), maxRetries: 1 });
      const est = (res.durationInSeconds ?? 0) * (MEDIA_LIST_PRICES[a.model]?.perSecond ?? 0.0001);
      const microUsd = await bill("stt", a.model, gatewayCost(res.providerMetadata), est);
      return { text: res.text, durationSec: res.durationInSeconds, words: res.words, microUsd, latencyMs: Date.now() - t0, model: a.model, warnings: warn(res.warnings) };
    },

    async image(a) {
      const t0 = Date.now();
      const res = await generateImage({
        model: gateway.imageModel(a.model),
        prompt: a.prompt,
        n: 1,
        ...(a.size ? { size: a.size } : {}),
        ...(a.aspectRatio ? { aspectRatio: a.aspectRatio } : {}),
        seed: a.seed,
        abortSignal: timeout(),
        maxRetries: 1,
      });
      const img = res.images[0];
      if (!img) throw new Error(`image model ${a.model} returned no image`);
      const microUsd = await bill("image", a.model, gatewayCost(res.providerMetadata), MEDIA_LIST_PRICES[a.model]?.perImage ?? 0.05);
      return { image: img.uint8Array, mediaType: img.mediaType, microUsd, latencyMs: Date.now() - t0, model: a.model, warnings: warn(res.warnings) };
    },
  };
}

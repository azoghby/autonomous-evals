/**
 * Media model defaults for Sandbox Evals (voice + vision). See docs/SANDBOX_EVALS_PLAN.md §7.
 *
 * Every id below was verified against the live Vercel AI Gateway catalog
 * (GET https://ai-gateway.vercel.sh/v1/models) on 2026-11-07, and the `type` the catalog reports
 * is noted. All of them are served natively by `@ai-sdk/gateway@4` (gateway.speechModel /
 * transcriptionModel / imageModel / languageModel), so no OpenAI-compatible fallback is needed.
 *
 * Prices are list prices from the catalog, used only when the gateway does not report a cost.
 */

export const MEDIA_MODELS = {
  /** Text-to-speech for the simulated user (catalog type "speech"). */
  tts: {
    /** $0.04 / 1k chars. Best prosody/accents. */
    primary: "elevenlabs/eleven-v4",
    /** Token-priced, cheap; good fallback and supports style instructions. */
    fallback: "google/gemini-3.8-flash-tts",
    /** Cheapest well-known fallback, $0.015 / 1k chars. */
    budget: "openai/tts-1",
  },
  /** Transcription of the agent's audio replies and STT oracle (catalog type "transcription"). */
  stt: {
    /** $0.000030556 / second (~$0.11/h); word timestamps. */
    primary: "elevenlabs/scribe-v2",
    fallback: "openai/gpt-4o-transcribe",
    alt: "google/gemini-3.5-transcribe",
  },
  /** Vision reader for the media oracle (catalog type "language", image input). */
  vision: {
    /** Cheap and strong OCR; default oracle reader. */
    primary: "google/gemini-3-flash",
    /** Second opinion / escalation reader. */
    secondary: "anthropic/claude-sonnet-5.5",
  },
  /** Photo-type attachments (catalog type "image"). */
  image: {
    primary: "bfl/flux-2-pro",
    /** $0.04 / image. */
    fallback: "bytedance/seedream-4.5",
  },
} as const;

export type MediaModelRole = keyof typeof MEDIA_MODELS;

/** List prices (USD) used for estimates when the gateway reports no cost. */
export const MEDIA_LIST_PRICES: Record<string, { perChar?: number; perSecond?: number; perImage?: number; inputPerMTok?: number; outputPerMTok?: number }> = {
  "elevenlabs/eleven-v4": { perChar: 0.00004 },
  "openai/tts-1": { perChar: 0.000015 },
  "elevenlabs/scribe-v2": { perSecond: 0.000030556 },
  "google/gemini-3-flash": { inputPerMTok: 0.5, outputPerMTok: 3 },
  "anthropic/claude-sonnet-5.5": { inputPerMTok: 2, outputPerMTok: 10 },
  "bytedance/seedream-4.5": { perImage: 0.04 },
};

/** Persona pace → TTS speed multiplier (provider support varies; unsupported speed surfaces as an SDK warning). */
export const PACE_SPEED = { slow: 0.85, normal: 1, fast: 1.2 } as const;

/**
 * Model catalog for Track B. Ids verified against the live catalogs on 2026-11-07:
 *  - Vercel AI Gateway: GET https://ai-gateway.vercel.sh/v1/models  (ids use dots: anthropic/claude-sonnet-5.5)
 *  - Neon AI Gateway:   docs/ai-gateway/overview                    (ids use dashes, no vendor prefix: claude-sonnet-5-5)
 * Prices are USD per million tokens (list price); used only when a gateway does not report cost itself.
 */
export interface ModelSpec {
  /** Vercel AI Gateway model id. */
  vercel: string;
  /** Neon AI Gateway model id (OpenAI-compatible chat completions). */
  neon: string;
  /** USD per 1M tokens (list). */
  priceUsdPerMTok: { input: number; output: number };
}

export const MODELS = {
  /** Default worker/judge: strong, cheap enough for suites. */
  sonnet: {
    vercel: "anthropic/claude-sonnet-5.5",
    neon: "claude-sonnet-5-5",
    priceUsdPerMTok: { input: 2, output: 10 },
  },
  /** Cheap and fast: smoke tests, classification, bulk grading. */
  haiku: {
    vercel: "anthropic/claude-haiku-5.5",
    neon: "claude-haiku-5-5",
    priceUsdPerMTok: { input: 0.1, output: 0.5 },
  },
  /** Heavier reasoning for investigators / adversarial judging. */
  opus: {
    vercel: "anthropic/claude-opus-5.5",
    neon: "claude-opus-5-5",
    priceUsdPerMTok: { input: 4, output: 20 },
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelAlias = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelAlias = "sonnet";

export function resolveModel(model: ModelAlias | ModelSpec): ModelSpec {
  return typeof model === "string" ? MODELS[model] : model;
}

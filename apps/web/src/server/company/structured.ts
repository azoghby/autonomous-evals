import "server-only";
/**
 * Structured generation for company agents: native structured output (AI SDK Output.object) on the Vercel AI Gateway,
 * which avoids the invalid-JSON failures that long text-JSON answers hit, with the shared text-JSON generateStructured
 * (Vercel -> Neon fallback) as the fallback. Same signature and cost recording as @ae/core/ai/gateway generateStructured.
 */
import { generateText as aiGenerateText, Output } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import {
  GatewayError, assertNoCredentials, generateStructured, type GenerateStructuredArgs, type StructuredResult,
} from "@ae/core/ai/gateway";
import { DEFAULT_MODEL, resolveModel } from "@ae/core/ai/models";

function reportedMicroUsd(meta: unknown): number | null {
  const c = (meta as { gateway?: { cost?: string | number } } | undefined)?.gateway?.cost;
  const n = typeof c === "string" ? Number.parseFloat(c) : c;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 1_000_000) : null;
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
/** Public URLs (slugs like ".../help-desk-ai-agents-...") trip the "sk-..." key pattern; check the text around them instead. */
export const maskUrls = (s: string | undefined): string | undefined => s?.replace(URL_RE, "[url]");

function passesGuard(...texts: Array<string | undefined>): boolean {
  try { assertNoCredentials(...texts); return true; } catch { return false; }
}

export async function companyStructured<T>(args: GenerateStructuredArgs<T>): Promise<StructuredResult<T>> {
  assertNoCredentials(maskUrls(args.system), maskUrls(args.prompt));
  const fallback = (err?: unknown) => {
    if (!passesGuard(args.system, args.prompt)) {
      throw err ? new GatewayError("malformed_output", `Native structured output failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`)
        : new GatewayError("not_configured", "Native structured output unavailable and prompt URLs trip the text-path credential guard.");
    }
    return generateStructured(args);
  };
  if (args.ctx.budgetMicroUsd !== undefined && args.ctx.budgetMicroUsd <= 0) throw new GatewayError("budget_exhausted", "Run budget exhausted; refusing model call.");
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key && !process.env.VERCEL_OIDC_TOKEN && process.env.VERCEL !== "1") return fallback();
  const spec = resolveModel(args.model ?? DEFAULT_MODEL);
  const started = Date.now();
  try {
    const res = await aiGenerateText({
      model: (key ? createGateway({ apiKey: key }) : createGateway())(spec.vercel),
      system: args.system, prompt: args.prompt, output: Output.object({ schema: args.schema }),
      maxOutputTokens: args.maxOutputTokens ?? 2000, temperature: args.temperature,
      abortSignal: AbortSignal.timeout(args.timeoutMs ?? 90_000), maxRetries: 0,
    });
    const inputTokens = res.usage?.inputTokens ?? 0;
    const outputTokens = res.usage?.outputTokens ?? 0;
    const reported = reportedMicroUsd(res.providerMetadata);
    const microUsd = reported ?? Math.round((inputTokens * spec.priceUsdPerMTok.input + outputTokens * spec.priceUsdPerMTok.output));
    const costBasis = reported === null ? "list_price_estimate" as const : "gateway_reported" as const;
    await args.ctx.recordCost({ source: "ai_gateway", agent: args.agent, microUsd, meta: { provider: "vercel", model: spec.vercel, inputTokens, outputTokens, costBasis, mode: "native_structured" } });
    const object = args.schema.parse(res.output);
    return { text: JSON.stringify(object), object, provider: "vercel", model: spec.vercel, inputTokens, outputTokens, microUsd, costBasis, latencyMs: Date.now() - started };
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    // Schema features the provider's structured mode rejects, or a provider hiccup: fall back to text JSON.
    return fallback(err);
  }
}

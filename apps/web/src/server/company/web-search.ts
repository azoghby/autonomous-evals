import "server-only";
/**
 * Web research for company agents via a search-capable AI Gateway model (perplexity/sonar: live web search,
 * returns source URLs). Costs are recorded against the run through ctx.gateway.recordCost, and the per-run
 * budget is enforced before every call. Inject a fake WebSearch in tests.
 */
import { generateText as aiGenerateText } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { GatewayError, assertNoCredentials, type GatewayContext } from "@ae/core/ai/gateway";

export const WEB_SEARCH_MODEL = "perplexity/sonar";
/** List-price fallback when the gateway does not report cost: $1/M in, $1/M out + $5 per 1k searches. */
const FALLBACK_MICRO_USD_PER_CALL = 6_000;

export interface WebSource { url: string; title?: string; snippet?: string; date?: string }
export interface WebSearchResult { text: string; sources: WebSource[]; microUsd: number }
export type WebSearch = (query: string, ctx: GatewayContext, opts?: { maxOutputTokens?: number }) => Promise<WebSearchResult>;

/** Only http(s) URLs, no credentials in them, deduped. */
export function cleanSources(raw: ReadonlyArray<{ url?: unknown; title?: unknown; snippet?: unknown; date?: unknown }>): WebSource[] {
  const seen = new Set<string>();
  const out: WebSource[] = [];
  for (const s of raw) {
    if (typeof s.url !== "string") continue;
    let u: URL;
    try { u = new URL(s.url); } catch { continue; }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (u.username || u.password) continue;
    const key = u.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: key,
      ...(typeof s.title === "string" ? { title: s.title.slice(0, 200) } : {}),
      ...(typeof s.snippet === "string" ? { snippet: s.snippet.slice(0, 1500) } : {}),
      ...(typeof s.date === "string" ? { date: s.date.slice(0, 20) } : {}),
    });
  }
  return out;
}

export const gatewayWebSearch: WebSearch = async (query, ctx, opts = {}) => {
  assertNoCredentials(query);
  if (ctx.budgetMicroUsd !== undefined && ctx.budgetMicroUsd < FALLBACK_MICRO_USD_PER_CALL) {
    throw new GatewayError("budget_exhausted", "Run budget exhausted; refusing web search.");
  }
  const key = process.env.AI_GATEWAY_API_KEY;
  const gw = key ? createGateway({ apiKey: key }) : createGateway();
  const res = await aiGenerateText({
    model: gw(WEB_SEARCH_MODEL), prompt: query, maxOutputTokens: opts.maxOutputTokens ?? 900,
    abortSignal: AbortSignal.timeout(60_000), maxRetries: 1,
  });
  const reported = (res.providerMetadata as { gateway?: { cost?: string | number } } | undefined)?.gateway?.cost;
  const usd = typeof reported === "string" ? Number.parseFloat(reported) : reported;
  const microUsd = typeof usd === "number" && Number.isFinite(usd) ? Math.round(usd * 1_000_000) : FALLBACK_MICRO_USD_PER_CALL;
  await ctx.recordCost({
    source: "ai_gateway", microUsd,
    meta: { provider: "vercel", model: WEB_SEARCH_MODEL, inputTokens: res.usage?.inputTokens ?? 0, outputTokens: res.usage?.outputTokens ?? 0, costBasis: reported === undefined ? "list_price_estimate" : "gateway_reported" },
  });
  const sources = cleanSources((res.sources ?? []).map((s) => {
    const meta = (s as { providerMetadata?: { perplexity?: { snippet?: string; date?: string } } }).providerMetadata?.perplexity;
    return { url: (s as { url?: string }).url, title: (s as { title?: string }).title, snippet: meta?.snippet, date: meta?.date };
  }));
  return { text: res.text, sources, microUsd };
};

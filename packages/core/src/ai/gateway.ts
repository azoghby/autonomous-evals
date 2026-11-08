/**
 * Model access for Track B (agents, judges). One entry point, two providers:
 * Vercel AI Gateway (primary) -> Neon AI Gateway (fallback, OpenAI-compatible).
 * Every successful call records a CostEntry (source "ai_gateway") through ctx.recordCost.
 */
import { generateText as aiGenerateText } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import type { CostEntry } from "../contracts";
import { DEFAULT_MODEL, resolveModel, type ModelAlias, type ModelSpec } from "./models";

export type GatewayProvider = "vercel" | "neon";
export type GatewayErrorCode = "credential_leak" | "malformed_output" | "all_providers_failed" | "budget_exhausted" | "not_configured";

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly details: { attempts?: Array<{ provider: GatewayProvider; error: string }>; raw?: string } = {},
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Minimal slice of ServiceContext this module needs. */
export interface GatewayContext {
  budgetMicroUsd?: number;
  recordCost(entry: Omit<CostEntry, "jobId">): Promise<void>;
}

export interface GenerateTextArgs {
  model?: ModelAlias | ModelSpec;
  system?: string;
  prompt: string;
  ctx: GatewayContext;
  agent?: CostEntry["agent"];
  maxOutputTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  /** Restrict/reorder providers (tests, smoke). Default: ["vercel", "neon"]. */
  providers?: GatewayProvider[];
}
export interface GenerateStructuredArgs<T> extends GenerateTextArgs {
  schema: z.ZodType<T>;
}
export interface GatewayResult {
  text: string;
  provider: GatewayProvider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  microUsd: number;
  costBasis: "gateway_reported" | "list_price_estimate";
  latencyMs: number;
}
export interface StructuredResult<T> extends GatewayResult { object: T }

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2_000;
const DEFAULT_PROVIDERS: GatewayProvider[] = ["vercel", "neon"];

/* ---------------- credential-leak guard ---------------- */

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/,                 // OpenAI / Anthropic style
  /\b(?:nt|nak|nsk)_live_[A-Za-z0-9_]{8,}/, // Neon credentials
  /\bAKIA[0-9A-Z]{16}\b/,                  // AWS access key id
  /\bAIza[0-9A-Za-z_-]{30,}/,              // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,          // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,        // Slack tokens
  /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}/,  // Stripe live keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/,    // Authorization headers
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Throws if text looks like it carries a credential. Customer secrets must never reach a model. */
export function assertNoCredentials(...texts: Array<string | undefined>): void {
  for (const t of texts) {
    if (!t) continue;
    if (SECRET_PATTERNS.some((re) => re.test(t))) {
      throw new GatewayError("credential_leak", "Prompt rejected: it appears to contain a credential or API key.");
    }
  }
}

/* ---------------- provider plumbing ---------------- */

function vercelConfigured(): boolean {
  // On Vercel the OIDC token arrives per request (read by @vercel/oidc), so VERCEL=1 counts as configured.
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL === "1");
}
function neonConfigured(): boolean {
  return Boolean(process.env.NEON_AI_GATEWAY_URL && process.env.NEON_AI_GATEWAY_KEY);
}

function buildModel(provider: GatewayProvider, spec: ModelSpec) {
  if (provider === "vercel") {
    const key = process.env.AI_GATEWAY_API_KEY;
    return (key ? createGateway({ apiKey: key }) : createGateway())(spec.vercel);
  }
  const base = process.env.NEON_AI_GATEWAY_URL!.replace(/\/+$/, "");
  return createOpenAICompatible({
    name: "neon",
    baseURL: `${base}/v1`,
    apiKey: process.env.NEON_AI_GATEWAY_KEY!,
  })(spec.neon);
}

/** Retryable = try the next provider. Everything else (bad request, schema) is surfaced. */
export function isRetryable(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; name?: string; message?: string; cause?: unknown; isRetryable?: boolean };
  const status = e?.statusCode ?? e?.status;
  if (typeof status === "number") return status === 429 || status === 408 || status === 401 || status === 402 || status === 403 || status >= 500;
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return true;
  if (e?.isRetryable) return true;
  const msg = `${e?.message ?? ""}`.toLowerCase();
  if (/timeout|timed out|econnreset|enotfound|fetch failed|rate limit|overloaded|unauthenticated|oidc|api key|credit/.test(msg)) return true;
  return e?.cause ? isRetryable(e.cause) : false;
}

function errMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.slice(0, 300);
}

function usdToMicro(usd: number): number {
  return Math.max(0, Math.round(usd * 1_000_000));
}

function computeCost(
  provider: GatewayProvider,
  spec: ModelSpec,
  inputTokens: number,
  outputTokens: number,
  providerMetadata: unknown,
): { microUsd: number; basis: GatewayResult["costBasis"] } {
  if (provider === "vercel") {
    const gw = (providerMetadata as { gateway?: { cost?: string | number; marketCost?: string | number } } | undefined)?.gateway;
    const reported = gw?.cost ?? gw?.marketCost;
    const n = typeof reported === "string" ? Number.parseFloat(reported) : reported;
    if (typeof n === "number" && Number.isFinite(n)) return { microUsd: usdToMicro(n), basis: "gateway_reported" };
  }
  const p = spec.priceUsdPerMTok;
  const usd = (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  return { microUsd: usdToMicro(usd), basis: "list_price_estimate" };
}

/* ---------------- generateText ---------------- */

export async function generateText(args: GenerateTextArgs): Promise<GatewayResult> {
  assertNoCredentials(args.system, args.prompt);
  if (args.ctx.budgetMicroUsd !== undefined && args.ctx.budgetMicroUsd <= 0) {
    throw new GatewayError("budget_exhausted", "Job budget exhausted; refusing model call.");
  }
  const spec = resolveModel(args.model ?? DEFAULT_MODEL);
  const order = args.providers ?? DEFAULT_PROVIDERS;
  const attempts: Array<{ provider: GatewayProvider; error: string }> = [];

  for (const provider of order) {
    const configured = provider === "vercel" ? vercelConfigured() : neonConfigured();
    if (!configured) {
      attempts.push({ provider, error: "not configured" });
      continue;
    }
    const started = Date.now();
    try {
      const res = await aiGenerateText({
        model: buildModel(provider, spec),
        system: args.system,
        prompt: args.prompt,
        maxOutputTokens: args.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: args.temperature,
        abortSignal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        maxRetries: 0, // provider fallback replaces in-provider retries
      });
      const inputTokens = res.usage?.inputTokens ?? 0;
      const outputTokens = res.usage?.outputTokens ?? 0;
      const { microUsd, basis } = computeCost(provider, spec, inputTokens, outputTokens, res.providerMetadata);
      const model = provider === "vercel" ? spec.vercel : spec.neon;
      await args.ctx.recordCost({
        source: "ai_gateway",
        agent: args.agent,
        microUsd,
        meta: { provider, model, inputTokens, outputTokens, costBasis: basis },
      });
      return { text: res.text, provider, model, inputTokens, outputTokens, microUsd, costBasis: basis, latencyMs: Date.now() - started };
    } catch (err) {
      attempts.push({ provider, error: errMessage(err) });
      if (!isRetryable(err)) {
        throw new GatewayError("all_providers_failed", `${provider} gateway call failed (non-retryable): ${errMessage(err)}`, { attempts });
      }
    }
  }
  const allUnconfigured = attempts.every((a) => a.error === "not configured");
  throw new GatewayError(
    allUnconfigured ? "not_configured" : "all_providers_failed",
    allUnconfigured
      ? "No AI gateway configured (set AI_GATEWAY_API_KEY/VERCEL_OIDC_TOKEN or NEON_AI_GATEWAY_URL+NEON_AI_GATEWAY_KEY)."
      : `All AI gateway providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join("; ")}`,
    { attempts },
  );
}

/* ---------------- generateStructured ---------------- */

/** Pulls the first JSON value out of model text (tolerates code fences and prose around it). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[{[]/);
    if (start === -1) throw new Error("no JSON found");
    const open = body[start];
    const end = body.lastIndexOf(open === "{" ? "}" : "]");
    if (end <= start) throw new Error("unterminated JSON");
    return JSON.parse(body.slice(start, end + 1));
  }
}

export async function generateStructured<T>(args: GenerateStructuredArgs<T>): Promise<StructuredResult<T>> {
  const jsonSchema = JSON.stringify(z.toJSONSchema(args.schema));
  const system = [
    args.system,
    "Respond with a single JSON value that conforms exactly to this JSON Schema. No prose, no code fences.",
    jsonSchema,
  ].filter(Boolean).join("\n\n");

  const res = await generateText({ ...args, system });

  let parsed: unknown;
  try {
    parsed = extractJson(res.text);
  } catch (e) {
    throw new GatewayError("malformed_output", `Model output is not valid JSON: ${errMessage(e)}`, { raw: res.text.slice(0, 500) });
  }
  const check = args.schema.safeParse(parsed);
  if (!check.success) {
    throw new GatewayError("malformed_output", `Model output failed schema validation: ${check.error.message.slice(0, 300)}`, { raw: res.text.slice(0, 500) });
  }
  return { ...res, object: check.data };
}

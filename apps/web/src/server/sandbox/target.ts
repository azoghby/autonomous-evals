/**
 * Target resolution for sandbox runs (tool_loop mode only today).
 * - AI Gateway target: endpoint host ai-gateway.vercel.sh -> we call it with OUR key, restricted to an allowlist of
 *   models with known prices, and meter the spend (usage tokens x list price) into the run budget.
 * - Customer endpoint: called without credentials (stored credentials are not supported yet); their spend, not ours.
 */
import type { GatewayContext } from "@ae/core/ai/gateway";
import type { ToolLoopTarget } from "@ae/core/sandbox/engine/driver";
import type { EnvironmentSpec, IntegrationMode } from "@ae/core/sandbox/spec";
import { HttpsJsonTransport, TargetError, TargetGate, type JsonTransport } from "@ae/core/targets/transport";

export const GATEWAY_CHAT_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
export const GATEWAY_HOST = "ai-gateway.vercel.sh";

/** Models we pay for as a sandbox target. USD per 1M tokens (list), conservative. */
export const GATEWAY_TARGET_MODELS: Record<string, { input: number; output: number }> = {
  "openai/gpt-5-mini": { input: 0.25, output: 2 },
  "openai/gpt-5-nano": { input: 0.05, output: 0.4 },
  "openai/gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "anthropic/claude-haiku-5.5": { input: 0.1, output: 0.5 },
  "google/gemini-2.5-flash": { input: 0.3, output: 2.5 },
  // Frontier models (AI Gateway list prices, USD per 1M tokens, checked Nov 8 2026).
  "anthropic/claude-sonnet-5.5": { input: 2, output: 10 },
  "anthropic/claude-opus-5.5": { input: 4, output: 20 },
  "openai/gpt-5.5": { input: 5, output: 30 },
  "google/gemini-3.8-flash": { input: 0.75, output: 3.75 },
};

export class SandboxInputError extends Error {
  constructor(message: string, readonly status: 400 | 402 | 404 | 409 | 422 | 429 = 422, readonly field?: string) {
    super(message);
    this.name = "SandboxInputError";
  }
}

export const isGatewayEndpoint = (url: string): boolean => {
  try { return new URL(url).hostname.toLowerCase() === GATEWAY_HOST; } catch { return false; }
};

/** Validates an integration for running. Throws SandboxInputError with a user-facing reason. */
export function assertRunnableIntegration(integration: IntegrationMode): asserts integration is Extract<IntegrationMode, { mode: "tool_loop" }> {
  if (integration.mode !== "tool_loop") {
    throw new SandboxInputError(`The "${integration.mode}" connect mode cannot run yet. Use Endpoint (tool_loop): an OpenAI-compatible chat completions URL.`, 422, "integration.mode");
  }
  if (integration.credentialRef) {
    throw new SandboxInputError("Stored credentials are not supported yet. Use an endpoint that needs no key, or the AI Gateway model target.", 422, "integration.credentialRef");
  }
  if (isGatewayEndpoint(integration.endpointUrl) && !GATEWAY_TARGET_MODELS[integration.model]) {
    throw new SandboxInputError(`AI Gateway target model must be one of: ${Object.keys(GATEWAY_TARGET_MODELS).join(", ")}`, 422, "integration.model");
  }
}

export interface ResolvedTarget {
  target: ToolLoopTarget;
  /** Present when we pay for the target's tokens. */
  price?: { input: number; output: number };
}

export function resolveSandboxTarget(env: EnvironmentSpec, gatewayKey: string | undefined): ResolvedTarget {
  const integration = env.integration;
  assertRunnableIntegration(integration);
  const base: ToolLoopTarget = {
    endpointUrl: integration.endpointUrl,
    model: integration.model,
    maxCompletionTokens: 4_000,
    ...(integration.systemPrompt ? { systemPrompt: integration.systemPrompt } : {}),
  };
  if (!isGatewayEndpoint(integration.endpointUrl)) return { target: base };
  if (!gatewayKey) throw new Error("AI_GATEWAY_API_KEY is not configured");
  return { target: { ...base, apiKey: gatewayKey }, price: GATEWAY_TARGET_MODELS[integration.model]! };
}

interface Usage { prompt_tokens?: number; completion_tokens?: number }

/** Cost in micro-USD of one completion at list price. Missing usage is charged as maxCompletionTokens of output. */
export function usageMicroUsd(usage: Usage | undefined, price: { input: number; output: number }, fallbackOutputTokens = 4_000): number {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? (usage ? 0 : fallbackOutputTokens);
  return Math.ceil(input * price.input + output * price.output);
}

/**
 * Wraps the target transport: refuses calls once the run budget is spent and records each completion's cost.
 * Only used for targets we pay for (AI Gateway).
 */
export function meteredTransport(ctx: GatewayContext, price: { input: number; output: number }, base: JsonTransport = new HttpsJsonTransport({ gate: new TargetGate() })): JsonTransport {
  return {
    async post(endpoint, body, bearer) {
      if (ctx.budgetMicroUsd !== undefined && ctx.budgetMicroUsd <= 0) throw new TargetError("budget_exhausted");
      const res = await base.post(endpoint, body, bearer);
      const usage = (res as { usage?: Usage } | null)?.usage;
      await ctx.recordCost({ source: "ai_gateway", microUsd: usageMicroUsd(usage, price), meta: { kind: "sandbox_target", model: (body as { model?: string })?.model ?? null, usage: usage ?? null } });
      return res;
    },
  };
}

import { describe, expect, it, vi } from "vitest";
import { TargetError, type JsonTransport } from "@ae/core/targets/transport";
import type { EnvironmentSpec } from "@ae/core/sandbox/spec";
import { miniEnv } from "@ae/core/sandbox/engine/testing/fixtures";
import { memoryCtx } from "@ae/core/sandbox/engine/testing/fake-gateway";
import {
  assertRunnableIntegration, GATEWAY_CHAT_URL, GATEWAY_TARGET_MODELS, isGatewayEndpoint, meteredTransport, resolveSandboxTarget, SandboxInputError, usageMicroUsd,
} from "./target";

const withIntegration = (integration: unknown): EnvironmentSpec => ({ ...miniEnv, integration } as EnvironmentSpec);
const gatewayEnv = (model = "openai/gpt-5-mini") => withIntegration({ mode: "tool_loop", endpointUrl: GATEWAY_CHAT_URL, model });
const PRICE = { input: 0.25, output: 2 };
const thrown = (fn: () => void): unknown => { try { fn(); } catch (e) { return e; } return undefined; };

describe("assertRunnableIntegration", () => {
  it("accepts a plain tool_loop endpoint", () => {
    expect(() => assertRunnableIntegration(miniEnv.integration)).not.toThrow();
  });

  it("rejects non tool_loop modes with a 422 on integration.mode", () => {
    const err = thrown(() => assertRunnableIntegration({ mode: "staging", chatEndpointUrl: "https://x.example.com/c" } as never));
    expect(err).toBeInstanceOf(SandboxInputError);
    expect(err).toMatchObject({ status: 422, field: "integration.mode" });
    expect((err as Error).message).toContain("staging");
  });

  it("rejects credentialRef", () => {
    const err = thrown(() => assertRunnableIntegration({ mode: "tool_loop", endpointUrl: "https://a.example.com/v1/chat/completions", model: "m", credentialRef: "cred_1" } as never));
    expect(err).toMatchObject({ field: "integration.credentialRef" });
  });

  it("rejects non-allowlisted gateway models and lists the allowed ones", () => {
    const err = thrown(() => assertRunnableIntegration({ mode: "tool_loop", endpointUrl: GATEWAY_CHAT_URL, model: "openai/gpt-9-ultra" }));
    expect(err).toMatchObject({ field: "integration.model" });
    expect((err as Error).message).toContain("openai/gpt-5-mini");
  });

  it("accepts every allowlisted gateway model", () => {
    for (const model of Object.keys(GATEWAY_TARGET_MODELS)) {
      expect(() => assertRunnableIntegration({ mode: "tool_loop", endpointUrl: GATEWAY_CHAT_URL, model })).not.toThrow();
    }
  });
});

describe("isGatewayEndpoint", () => {
  it("matches the host only (case-insensitive), not look-alikes or garbage", () => {
    expect(isGatewayEndpoint("https://AI-GATEWAY.vercel.sh/v1/chat/completions")).toBe(true);
    expect(isGatewayEndpoint("https://ai-gateway.vercel.sh.evil.com/v1")).toBe(false);
    expect(isGatewayEndpoint("https://evil.com/ai-gateway.vercel.sh")).toBe(false);
    expect(isGatewayEndpoint("not a url")).toBe(false);
  });
});

describe("resolveSandboxTarget", () => {
  it("customer endpoint: no key, no price (their spend)", () => {
    const { target, price } = resolveSandboxTarget(miniEnv, "OUR-KEY");
    expect(price).toBeUndefined();
    expect(target.apiKey).toBeUndefined();
    expect(target).toMatchObject({ endpointUrl: "https://agent.example.com/v1/chat/completions", model: "test-model", maxCompletionTokens: 4_000 });
    expect(JSON.stringify({ target, price })).not.toContain("OUR-KEY");
  });

  it("includes systemPrompt when present", () => {
    const env = withIntegration({ mode: "tool_loop", endpointUrl: "https://a.example.com/c", model: "m", systemPrompt: "Be nice" });
    expect(resolveSandboxTarget(env, undefined).target.systemPrompt).toBe("Be nice");
  });

  it("gateway endpoint: uses OUR key and the model price", () => {
    const { target, price } = resolveSandboxTarget(gatewayEnv("openai/gpt-5-nano"), "OUR-KEY");
    expect(target.apiKey).toBe("OUR-KEY");
    expect(price).toEqual(GATEWAY_TARGET_MODELS["openai/gpt-5-nano"]);
  });

  it("gateway endpoint without a configured key throws", () => {
    expect(() => resolveSandboxTarget(gatewayEnv(), undefined)).toThrow("AI_GATEWAY_API_KEY is not configured");
  });

  it("rejects unrunnable integrations", () => {
    expect(() => resolveSandboxTarget(withIntegration({ mode: "staging", chatEndpointUrl: "https://x.example.com/c" }), "k")).toThrow(SandboxInputError);
  });
});

describe("usageMicroUsd", () => {
  it("computes ceil(input*price + output*price)", () => {
    expect(usageMicroUsd({ prompt_tokens: 1000, completion_tokens: 500 }, PRICE)).toBe(1250);
    expect(usageMicroUsd({ prompt_tokens: 3, completion_tokens: 1 }, { input: 0.05, output: 0.4 })).toBe(1);
  });
  it("charges the fallback output tokens when usage is missing", () => {
    expect(usageMicroUsd(undefined, PRICE)).toBe(8_000);
    expect(usageMicroUsd(undefined, PRICE, 100)).toBe(200);
  });
  it("does not apply the fallback when usage exists with partial fields", () => {
    expect(usageMicroUsd({ prompt_tokens: 100 }, PRICE)).toBe(25);
  });
});

describe("meteredTransport", () => {
  const baseWith = (res: unknown) => ({ post: vi.fn(async () => res) }) satisfies JsonTransport;

  it("records the cost of each completion and returns the response", async () => {
    const recorded: Array<{ microUsd: number; source: string; meta?: Record<string, unknown> }> = [];
    const ctx = { budgetMicroUsd: 1_000_000, recordCost: async (e: { microUsd: number; source: string; meta?: Record<string, unknown> }) => { recorded.push(e); } };
    const res = { usage: { prompt_tokens: 1000, completion_tokens: 500 }, choices: [] };
    const base = baseWith(res);
    await expect(meteredTransport(ctx as never, PRICE, base).post("https://x", { model: "openai/gpt-5-mini" }, "k")).resolves.toBe(res);
    expect(base.post).toHaveBeenCalledWith("https://x", { model: "openai/gpt-5-mini" }, "k");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ source: "ai_gateway", microUsd: 1250, meta: { kind: "sandbox_target", model: "openai/gpt-5-mini" } });
  });

  it("charges the fallback when the response has no usage", async () => {
    const ctx = memoryCtx(1_000_000);
    await meteredTransport(ctx as never, PRICE, baseWith({ choices: [] })).post("https://x", {}, undefined);
    expect(ctx.costs).toEqual([8_000]);
  });

  it("refuses without calling the target when the budget is 0", async () => {
    const base = baseWith({});
    const ctx = { budgetMicroUsd: 0, recordCost: vi.fn(async () => undefined) };
    const err = await meteredTransport(ctx as never, PRICE, base).post("https://x", {}, undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TargetError);
    expect((err as Error).message).toContain("budget_exhausted");
    expect(base.post).not.toHaveBeenCalled();
    expect(ctx.recordCost).not.toHaveBeenCalled();
  });

  it("refuses once recorded costs exhaust the budget", async () => {
    const ctx = memoryCtx(1_000);
    const t = meteredTransport(ctx as never, PRICE, baseWith({ usage: { prompt_tokens: 1000, completion_tokens: 500 } }));
    await t.post("https://x", {}, undefined);
    await expect(t.post("https://x", {}, undefined)).rejects.toThrow("budget_exhausted");
  });
});

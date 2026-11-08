import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const aiGenerate = vi.fn();
vi.mock("ai", () => ({ generateText: (...a: unknown[]) => aiGenerate(...a) }));
vi.mock("@ai-sdk/gateway", () => ({ createGateway: () => (id: string) => ({ provider: "vercel", id }) }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible: () => (id: string) => ({ provider: "neon", id }) }));

import { assertNoCredentials, GatewayError, generateStructured, generateText } from "./gateway";

const ok = (text: string, extra: Record<string, unknown> = {}) => ({
  text,
  usage: { inputTokens: 1000, outputTokens: 100 },
  providerMetadata: undefined,
  ...extra,
});
const httpErr = (statusCode: number) => Object.assign(new Error(`http ${statusCode}`), { statusCode });

let costs: Array<Record<string, unknown>>;
const ctx = () => ({ recordCost: async (e: Record<string, unknown>) => { costs.push(e); } }) as never;

beforeEach(() => {
  aiGenerate.mockReset();
  costs = [];
  process.env.AI_GATEWAY_API_KEY = "test";
  process.env.NEON_AI_GATEWAY_URL = "https://neon.example";
  process.env.NEON_AI_GATEWAY_KEY = "test";
  delete process.env.VERCEL_OIDC_TOKEN;
});

describe("provider order and fallback", () => {
  it("uses Vercel first and does not touch Neon on success", async () => {
    aiGenerate.mockResolvedValueOnce(ok("hi"));
    const r = await generateText({ prompt: "p", ctx: ctx() });
    expect(r.provider).toBe("vercel");
    expect(aiGenerate).toHaveBeenCalledTimes(1);
    expect(aiGenerate.mock.calls[0]![0].model).toMatchObject({ provider: "vercel", id: "anthropic/claude-sonnet-5.5" });
  });

  it.each([429, 500, 503, 401])("falls back to Neon on Vercel %s", async (status) => {
    aiGenerate.mockRejectedValueOnce(httpErr(status)).mockResolvedValueOnce(ok("hi"));
    const r = await generateText({ prompt: "p", ctx: ctx() });
    expect(r.provider).toBe("neon");
    expect(aiGenerate.mock.calls[1]![0].model).toMatchObject({ provider: "neon", id: "claude-sonnet-5-5" });
  });

  it("falls back on timeout", async () => {
    aiGenerate.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "TimeoutError" })).mockResolvedValueOnce(ok("hi"));
    expect((await generateText({ prompt: "p", ctx: ctx() })).provider).toBe("neon");
  });

  it("skips an unconfigured provider", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    aiGenerate.mockResolvedValueOnce(ok("hi"));
    expect((await generateText({ prompt: "p", ctx: ctx() })).provider).toBe("neon");
  });

  it("does not fall back on a non-retryable error (400)", async () => {
    aiGenerate.mockRejectedValueOnce(httpErr(400));
    await expect(generateText({ prompt: "p", ctx: ctx() })).rejects.toMatchObject({ code: "all_providers_failed" });
    expect(aiGenerate).toHaveBeenCalledTimes(1);
  });

  it("throws all_providers_failed when both fail, with attempts", async () => {
    aiGenerate.mockRejectedValue(httpErr(503));
    const err = await generateText({ prompt: "p", ctx: ctx() }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.code).toBe("all_providers_failed");
    expect(err.details.attempts.map((a: { provider: string }) => a.provider)).toEqual(["vercel", "neon"]);
    expect(costs).toHaveLength(0);
  });

  it("throws not_configured when nothing is configured", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.NEON_AI_GATEWAY_URL;
    await expect(generateText({ prompt: "p", ctx: ctx() })).rejects.toMatchObject({ code: "not_configured" });
  });

  it("refuses when the job budget is exhausted", async () => {
    await expect(generateText({ prompt: "p", ctx: { budgetMicroUsd: 0, recordCost: async () => {} } })).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(aiGenerate).not.toHaveBeenCalled();
  });
});

describe("cost recording", () => {
  it("records the gateway-reported cost as ai_gateway micro-USD with meta", async () => {
    aiGenerate.mockResolvedValueOnce(ok("hi", { providerMetadata: { gateway: { cost: "0.000027" } } }));
    const r = await generateText({ model: "haiku", prompt: "p", agent: "judge", ctx: ctx() });
    expect(r.microUsd).toBe(27);
    expect(costs).toEqual([{
      source: "ai_gateway", agent: "judge", microUsd: 27,
      meta: { provider: "vercel", model: "anthropic/claude-haiku-5.5", inputTokens: 1000, outputTokens: 100, costBasis: "gateway_reported" },
    }]);
  });

  it("estimates from list price on Neon", async () => {
    aiGenerate.mockRejectedValueOnce(httpErr(429)).mockResolvedValueOnce(ok("hi"));
    const r = await generateText({ model: "sonnet", prompt: "p", ctx: ctx() });
    // 1000 in * $2/M + 100 out * $10/M = $0.003
    expect(r.microUsd).toBe(3000);
    expect(costs[0]).toMatchObject({ microUsd: 3000, meta: { provider: "neon", model: "claude-sonnet-5-5", costBasis: "list_price_estimate" } });
  });
});

describe("generateStructured", () => {
  const schema = z.object({ score: z.number().min(0).max(1), reason: z.string() });

  it("parses fenced JSON and returns a typed object", async () => {
    aiGenerate.mockResolvedValueOnce(ok('Sure:\n```json\n{"score":0.5,"reason":"ok"}\n```'));
    const r = await generateStructured({ prompt: "p", schema, ctx: ctx() });
    expect(r.object).toEqual({ score: 0.5, reason: "ok" });
    expect(aiGenerate.mock.calls[0]![0].system).toContain("JSON Schema");
  });

  it("rejects schema-invalid output but still records the spend", async () => {
    aiGenerate.mockResolvedValueOnce(ok('{"score":7,"reason":"x"}'));
    await expect(generateStructured({ prompt: "p", schema, ctx: ctx() })).rejects.toMatchObject({ code: "malformed_output" });
    expect(costs).toHaveLength(1);
  });

  it("rejects non-JSON output without falling back", async () => {
    aiGenerate.mockResolvedValueOnce(ok("I cannot comply."));
    await expect(generateStructured({ prompt: "p", schema, ctx: ctx() })).rejects.toMatchObject({ code: "malformed_output" });
    expect(aiGenerate).toHaveBeenCalledTimes(1);
  });
});

describe("credential-leak guard", () => {
  it.each([
    "key is sk-abcdefghijklmnopqrstuvwxyz123456",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "nt_live_703845708ec4_abcdefghijklmnop",
    "AKIAABCDEFGHIJKLMNOP",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    "-----BEGIN RSA PRIVATE KEY-----",
  ])("rejects %#", (text) => {
    expect(() => assertNoCredentials(text)).toThrowError(GatewayError);
  });

  it("allows ordinary text", () => {
    expect(() => assertNoCredentials("Ask about the sky-high refund policy, 20 tasks.")).not.toThrow();
  });

  it("blocks the call before any provider is reached (prompt and system)", async () => {
    await expect(generateText({ prompt: "use sk-abcdefghijklmnopqrstuvwxyz123456", ctx: ctx() })).rejects.toMatchObject({ code: "credential_leak" });
    await expect(generateText({ system: "sk-abcdefghijklmnopqrstuvwxyz123456", prompt: "x", ctx: ctx() })).rejects.toMatchObject({ code: "credential_leak" });
    expect(aiGenerate).not.toHaveBeenCalled();
  });
});

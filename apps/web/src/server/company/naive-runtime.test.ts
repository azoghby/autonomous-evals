import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GenerateStructuredArgs, StructuredResult } from "@ae/core/ai/gateway";
import type { NaiveSessionSnapshot } from "@ae/core/evals/types";
import { withNaive, type LlmCallRecord, type NaiveCompanyClient } from "./naive-runtime";

const schema = z.object({ title: z.string() });
const ENV_ON = {
  COMPANY_AGENT_RUNTIME: "naive", NAIVE_API_KEY: "test-key",
  NAIVE_AGENT_COMPANY_OPERATOR: "agent-op", NAIVE_AGENT_COMMERCIAL: "agent-com",
};

const snap = (over: Partial<NaiveSessionSnapshot>): NaiveSessionSnapshot => ({
  id: "sess-1", agentId: "agent-op", agentVersion: 1, status: "running", stopReason: null, stopCode: null,
  structuredOutput: null, budgetMicroUsd: 100_000, consumedMicroUsd: 1234, tokenUsage: {}, metadata: {}, ...over,
});

function setup() {
  const calls: LlmCallRecord[] = [];
  const costs: Array<Record<string, unknown>> = [];
  const args: GenerateStructuredArgs<{ title: string }> = {
    system: "sys", prompt: "plan", schema,
    ctx: {
      budgetMicroUsd: 500_000,
      recordCost: async (e) => { costs.push(e as unknown as Record<string, unknown>); },
      logLlmCall: (r: LlmCallRecord) => calls.push(r),
    } as GenerateStructuredArgs<{ title: string }>["ctx"],
  };
  const gatewayResult = { object: { title: "from-gateway" }, text: "", provider: "vercel", model: "m", inputTokens: 0, outputTokens: 0, microUsd: 0, costBasis: "gateway_reported", latencyMs: 1 } as StructuredResult<{ title: string }>;
  const fallback = vi.fn(async () => gatewayResult) as unknown as Parameters<typeof withNaive>[1];
  return { calls, costs, args, fallback };
}

const noSleep = async () => {};

describe("withNaive", () => {
  it("serves from Naïve on success, validates with the schema, records a naive cost row with the session id", async () => {
    const { calls, costs, args, fallback } = setup();
    const client: NaiveCompanyClient = {
      createSession: vi.fn(async () => snap({ status: "running" })),
      getSession: vi.fn(async () => snap({ status: "idle", structuredOutput: { title: "from-naive" } })),
    };
    const res = await withNaive("planner", fallback, { env: ENV_ON, client, sleep: noSleep })(args);
    expect(res.object).toEqual({ title: "from-naive" });
    expect(fallback).not.toHaveBeenCalled();
    expect(vi.mocked(client.createSession).mock.calls[0][0].agent_id).toBe("agent-op");
    expect(costs[0]).toMatchObject({ source: "naive", sessionId: "sess-1", microUsd: 1234 });
    expect(calls).toEqual([{ runtime: "naive", role: "COMPANY_OPERATOR", sessionId: "sess-1" }]);
  });

  it("maps commercial agents to the COMMERCIAL role", async () => {
    const { args, fallback } = setup();
    const client: NaiveCompanyClient = {
      createSession: vi.fn(async () => snap({ status: "completed", structuredOutput: { title: "x" } })),
      getSession: vi.fn(),
    };
    await withNaive("prospecting", fallback, { env: ENV_ON, client, sleep: noSleep })(args);
    expect(vi.mocked(client.createSession).mock.calls[0][0].agent_id).toBe("agent-com");
  });

  it("falls back to the gateway on a 429 at capacity", async () => {
    const { calls, args, fallback } = setup();
    const client: NaiveCompanyClient = {
      createSession: vi.fn(async () => { throw Object.assign(new Error("at capacity"), { status: 429, kind: "rate_limited" }); }),
      getSession: vi.fn(),
    };
    const res = await withNaive("outreach", fallback, { env: ENV_ON, client, sleep: noSleep })(args);
    expect(res.object).toEqual({ title: "from-gateway" });
    expect(fallback).toHaveBeenCalledWith(args);
    expect(calls[0]).toMatchObject({ runtime: "gateway", fallbackReason: "rate_limited_429" });
  });

  it("falls back on a generic error and on timeout", async () => {
    const { args, fallback } = setup();
    const boom: NaiveCompanyClient = { createSession: vi.fn(async () => { throw new Error("network"); }), getSession: vi.fn() };
    expect((await withNaive("planner", fallback, { env: ENV_ON, client: boom, sleep: noSleep })(args)).object.title).toBe("from-gateway");
    const stuck: NaiveCompanyClient = { createSession: vi.fn(async () => snap({ status: "running" })), getSession: vi.fn(async () => snap({ status: "running" })) };
    const t = setup();
    const res = await withNaive("planner", t.fallback, { env: ENV_ON, client: stuck, timeoutMs: 1, sleep: () => new Promise((r) => setTimeout(r, 5)) })(t.args);
    expect(res.object.title).toBe("from-gateway");
    expect(t.calls[0]).toMatchObject({ runtime: "gateway", fallbackReason: "timeout", sessionId: "sess-1" });
  });

  it("falls back on a schema mismatch", async () => {
    const { calls, args, fallback } = setup();
    const client: NaiveCompanyClient = {
      createSession: vi.fn(async () => snap({ status: "idle", structuredOutput: { wrong: 1 } })),
      getSession: vi.fn(),
    };
    const res = await withNaive("market_research", fallback, { env: ENV_ON, client, sleep: noSleep })(args);
    expect(res.object.title).toBe("from-gateway");
    expect(calls[0]).toMatchObject({ runtime: "gateway", fallbackReason: "schema_mismatch", sessionId: "sess-1" });
  });

  it("uses the gateway when the runtime env is off or Naïve env vars are missing", async () => {
    const client: NaiveCompanyClient = { createSession: vi.fn(), getSession: vi.fn() };
    const off = setup();
    await withNaive("planner", off.fallback, { env: {}, client })(off.args);
    expect(off.calls[0]).toMatchObject({ runtime: "gateway", fallbackReason: "runtime_off" });
    const missing = setup();
    await withNaive("planner", missing.fallback, { env: { COMPANY_AGENT_RUNTIME: "naive" }, client })(missing.args);
    expect(missing.calls[0]).toMatchObject({ runtime: "gateway", fallbackReason: "missing_env" });
    expect(client.createSession).not.toHaveBeenCalled();
  });
});

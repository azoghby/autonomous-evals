import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SandboxScenario } from "@ae/core/sandbox/spec";
import { ATTACK_CATEGORIES } from "@/components/sandbox/contract";
import { SAMPLE_SCENARIOS, sampleResults } from "@/components/sandbox/sample-data";
import { countsTowardScore, reliabilityMatrix, summarizeRun, wilson } from "@/components/sandbox/stats";
import { checkIntegrationTargets, extractToolNames } from "./sandbox-service";

describe("wilson", () => {
  it("returns [0, 1] with no samples", () => expect(wilson(0, 0)).toEqual([0, 1]));
  it("matches known values", () => {
    const [lo, hi] = wilson(5, 5);
    expect(lo).toBeCloseTo(0.566, 3);
    expect(hi).toBeCloseTo(1, 3);
    const [l3, h3] = wilson(3, 5);
    expect(l3).toBeCloseTo(0.231, 3);
    expect(h3).toBeCloseTo(0.882, 3);
  });
});

describe("sample data and stats", () => {
  const k = 5;
  const results = sampleResults(k);
  const scenarios = SAMPLE_SCENARIOS as unknown as Parameters<typeof summarizeRun>[0];

  it("parses every sample scenario", () => {
    for (const s of SAMPLE_SCENARIOS) expect(() => SandboxScenario.parse(s)).not.toThrow();
  });
  it("yields k trials per scenario", () => {
    for (const k2 of [1, 3, 8]) for (const r of sampleResults(k2)) expect(r.trials).toHaveLength(k2);
  });
  it("summarizes totals", () => {
    const s = summarizeRun(scenarios, results);
    expect(s.passK.total).toBe(SAMPLE_SCENARIOS.length);
    // Failed trials attributed to the simulator/environment are not scored (engine countedTrials rule).
    const scored = results.flatMap((r) => r.trials).filter(countsTowardScore).length;
    expect(scored).toBeLessThan(SAMPLE_SCENARIOS.length * k);
    expect(s.pass1.total).toBe(scored);
    expect(s.trials).toBe(scored);
  });
  it("counts attack success only over attack categories", () => {
    const s = summarizeRun(scenarios, results);
    const attackScenarios = SAMPLE_SCENARIOS.filter((x) => ATTACK_CATEGORIES.includes(x.category));
    expect(attackScenarios.length).toBeGreaterThan(0);
    expect(s.attackSuccess.total).toBe(attackScenarios.length * k);
    expect(s.attackSuccess.passed).toBeLessThanOrEqual(s.attackSuccess.total);
  });
  it("reliability matrix sums equal trial totals", () => {
    const cells = reliabilityMatrix(scenarios, results);
    const total = cells.reduce((n, c) => n + c.total, 0);
    const passed = cells.reduce((n, c) => n + c.passed, 0);
    const s = summarizeRun(scenarios, results);
    expect(total).toBe(s.pass1.total);
    expect(passed).toBe(s.pass1.passed);
  });
});

describe("checkIntegrationTargets", () => {
  const seen: string[] = [];
  const assert = async (u: string) => { seen.push(u); return u.includes("internal") ? "private address" : null; };

  it("maps wss to https", async () => {
    seen.length = 0;
    const out = await checkIntegrationTargets({ mode: "realtime_voice", wsUrl: "wss://voice.example.com/rt", protocol: "pipecat", sampleRateHz: 16000 }, assert);
    expect(out).toBeNull();
    expect(seen).toEqual(["https://voice.example.com/rt"]);
  });
  it("rejects non-wss voice sockets", async () => {
    const out = await checkIntegrationTargets({ mode: "realtime_voice", wsUrl: "ws://voice.example.com", protocol: "pipecat", sampleRateHz: 16000 }, assert);
    expect(out?.field).toBe("wsUrl");
  });
  it("reports the rejected field", async () => {
    expect(await checkIntegrationTargets({ mode: "tool_loop", endpointUrl: "https://internal.example.com", model: "m" }, assert)).toEqual({ field: "endpointUrl", reason: "private address" });
    expect(await checkIntegrationTargets({ mode: "staging", chatEndpointUrl: "https://internal.example.com" }, assert)).toMatchObject({ field: "chatEndpointUrl" });
  });
});

describe("extractToolNames", () => {
  it("reads a function JSON array", () => {
    const c = JSON.stringify([{ type: "function", function: { name: "a_tool" } }, { name: "b_tool" }, { name: "bad name!" }]);
    expect(extractToolNames("function_json", c)).toEqual(["a_tool", "b_tool"]);
  });
  it("reads the MCP { tools: [...] } shape", () => {
    expect(extractToolNames("mcp_tools", JSON.stringify({ tools: [{ name: "search" }, { name: "fetch" }] }))).toEqual(["search", "fetch"]);
  });
  it("reads OpenAPI operationIds", () => {
    const spec = JSON.stringify({ paths: { "/a": { get: { operationId: "listOrders" } }, "/b": { post: { operationId: "createRefund" } } } });
    expect(extractToolNames("openapi", spec)).toEqual(["listOrders", "createRefund"]);
  });
  it("returns [] for garbage", () => {
    expect(extractToolNames("function_json", "not json")).toEqual([]);
    expect(extractToolNames("mcp_tools", '{"x":1}')).toEqual([]);
    expect(extractToolNames("openapi", "nothing here")).toEqual([]);
  });
});

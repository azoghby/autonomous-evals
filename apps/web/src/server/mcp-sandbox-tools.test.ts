import { describe, expect, it, vi } from "vitest";
import { buildSandboxTools, createMcpSandboxService, validateToolInput, type McpEngine } from "./mcp-sandbox-tools";
import type { McpCaller } from "./mcp-tools";
import { SandboxInputError } from "./sandbox/target";

const caller: McpCaller = { customerId: "c1", email: "a@b.co", origin: "https://x.test" };
const agent = { endpointUrl: "https://agent.example.com/v1/chat/completions", model: "m" };
const SECRET_POLICY = "TOP-SECRET-POLICY-TEXT";
const SECRET_SPEC = "TOP-SECRET-OPENAPI";

const draft = (over: Record<string, unknown> = {}) => ({
  draftId: "drf_1", environmentId: "env_1", status: "ready", costMicroUsd: 250_000,
  scenarios: [
    { scenario: { id: "sx_a", title: "Refund ok", category: "happy_path", workflowId: "wf", persona: { goal: "Get a refund" } }, validated: true, gateReasons: [] },
    { scenario: { id: "sx_b", title: "Refund late", category: "boundary", workflowId: "wf", persona: { goal: "x".repeat(500) } }, validated: false, gateReasons: ["r1", "r2", "r3"] },
  ],
  ...over,
});

const trial = (passed: boolean) => ({
  scenarioId: "sx_a", trial: 0, passed,
  checks: passed ? [] : [{ id: "ck1", kind: "state", passed: false, severity: "high", detail: "d".repeat(500), policyRef: "refund.1" }],
  transcript: [1, 2, 3, 4, 5].map((n) => ({ role: "user", content: `${n}${"y".repeat(500)}` })),
  toolCalls: [{ secret: "TOOLCALL" }], diff: [{ secret: "DIFF" }],
});
const report = (status = "complete") => ({
  runId: "run_1", status, k: 2, versions: { spec: 1 }, error: undefined,
  scenarios: [{ id: "sx_a", title: "Refund ok", category: "happy_path" }],
  workflows: [{ id: "wf", name: "Refunds" }],
  results: [{ scenarioId: "sx_a", workflowId: "wf", passRate: 0.5, reliable: false, ci95: [0.1, 0.9], trials: [trial(true), trial(false)] }],
  clusters: [{ id: "cl", title: "t", rootCause: "rc", attribution: "agent", severity: "high", policyRef: "refund.1", scenarioIds: ["sx_a"], trialCount: 1 }],
  costMicroUsd: 1_500_000, budgetMicroUsd: 3_000_000, progress: { trialsDone: 2, trialsTotal: 2 },
});

function makeEngine(over: Partial<Record<keyof McpEngine, unknown>> = {}) {
  const engine = {
    createEnvironment: vi.fn(async () => ({ environmentId: "env_1", name: "n", source: "custom", tools: 3, tables: ["t"], policies: 1, workflows: [{ id: "wf", name: "W" }], warnings: ["w"], summary: { secret: SECRET_POLICY } })),
    generateSuite: vi.fn(async () => draft({ status: "generating" })),
    getDraft: vi.fn(async () => draft()),
    startRun: vi.fn(async () => ({ ok: true as const, runId: "run_1" })),
    getRunReport: vi.fn(async () => report()),
    ...over,
  };
  return engine as unknown as McpEngine & typeof engine;
}
const setup = (engine = makeEngine()) => {
  const tools = buildSandboxTools(createMcpSandboxService(engine));
  const call = async (name: string, args: unknown) => {
    const t = tools.find((x) => x.name === name)!;
    const v = validateToolInput(t, args);
    return v.ok ? t.run(caller, v.value as never) : v.result;
  };
  return { engine, call };
};
const data = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("input validation", () => {
  it("requires a spec source unless prebuilt", async () => {
    const { call } = setup();
    expect((await call("sandbox_create_environment", { name: "n", agent })).isError).toBe(true);
    expect((await call("sandbox_create_environment", { name: "n", prebuilt: "acme-support", agent })).isError).toBeUndefined();
  });
  it("rejects non-https agent URLs and oversized openapi", async () => {
    const { call } = setup();
    expect((await call("sandbox_create_environment", { name: "n", openapi: "a", agent: { ...agent, endpointUrl: "http://a.com" } })).isError).toBe(true);
    expect((await call("sandbox_create_environment", { name: "n", openapi: "x".repeat(500_001), agent })).isError).toBe(true);
  });
  it("bounds k and scenarioIds, defaults k to 5", async () => {
    const { call } = setup();
    for (const k of [0, 11, 1.5]) expect((await call("sandbox_run", { environmentId: "e", suiteId: "s", k })).isError).toBe(true);
    expect((await call("sandbox_run", { environmentId: "e", suiteId: "s", scenarioIds: Array(13).fill("a") })).isError).toBe(true);
  });
  it("status needs exactly one of runId or suiteId", async () => {
    const { call } = setup();
    expect((await call("sandbox_status", {})).isError).toBe(true);
    expect((await call("sandbox_status", { runId: "a", suiteId: "b" })).isError).toBe(true);
  });
});

describe("sandbox_create_environment", () => {
  it("rejects apiKeyRef without calling the engine", async () => {
    const { call, engine } = setup();
    const r = await call("sandbox_create_environment", { name: "n", openapi: "a", agent: { ...agent, apiKeyRef: "my-key" } });
    expect(r.isError).toBe(true);
    expect(data(r).error).toContain("Stored credentials are not supported yet");
    expect(data(r).error).toContain("ai-gateway.vercel.sh");
    expect(engine.createEnvironment).not.toHaveBeenCalled();
  });
  it("maps input, scopes to customerId and does not echo content", async () => {
    const { call, engine } = setup();
    const r = await call("sandbox_create_environment", {
      name: "n", openapi: SECRET_SPEC, functions: '[{"a":1}]', mcpTools: [{ name: "x" }],
      policies: [SECRET_POLICY, { title: "Refunds", markdown: "m" }], agent: { ...agent, systemPrompt: "sp" },
    });
    expect(r.isError).toBeUndefined();
    const [owner, input] = engine.createEnvironment.mock.calls[0] as unknown as [string, Record<string, any>];
    expect(owner).toBe("c1");
    expect(input.integration).toEqual({ mode: "tool_loop", endpointUrl: agent.endpointUrl, model: "m", systemPrompt: "sp" });
    expect(input.world.functions).toEqual([{ a: 1 }]);
    expect(input.world.mcpTools).toEqual([{ name: "x" }]);
    expect(input.world.policies).toEqual([{ title: "Policy 1", text: SECRET_POLICY }, { title: "Refunds", text: "m" }]);
    const out = data(r);
    expect(out).toMatchObject({ environmentId: "env_1", next: "call sandbox_generate_suite" });
    expect(r.content[0].text).not.toContain(SECRET_POLICY);
    expect(r.content[0].text).not.toContain(SECRET_SPEC);
  });
  it("passes the prebuilt path without a world", async () => {
    const { call, engine } = setup();
    await call("sandbox_create_environment", { name: "n", prebuilt: "acme-support", agent });
    const input = (engine.createEnvironment.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(input.prebuilt).toBe("acme-support");
    expect(input.world).toBeUndefined();
  });
  it("returns a tool error for unparseable JSON strings", async () => {
    const { call, engine } = setup();
    const r = await call("sandbox_create_environment", { name: "n", functions: "{nope", agent });
    expect(r.isError).toBe(true);
    expect(engine.createEnvironment).not.toHaveBeenCalled();
  });
});

describe("sandbox_generate_suite", () => {
  it("starts generation", async () => {
    const { call, engine } = setup();
    const r = await call("sandbox_generate_suite", { environmentId: "env_1" });
    expect(engine.generateSuite).toHaveBeenCalledWith("c1", "env_1");
    expect(data(r)).toMatchObject({ suiteId: "drf_1", status: "generating" });
  });
  it("reports foreign/unknown environments as not found", async () => {
    const { call } = setup(makeEngine({ generateSuite: vi.fn(async () => null) }));
    const r = await call("sandbox_generate_suite", { environmentId: "env_x" });
    expect(r.isError).toBe(true);
    expect(data(r).error).toBe("Environment not found");
  });
});

describe("sandbox_status", () => {
  it("returns a suite preview when ready, clipped", async () => {
    const { call, engine } = setup();
    const out = data(await call("sandbox_status", { suiteId: "drf_1" }));
    expect(engine.getDraft).toHaveBeenCalledWith("c1", "drf_1");
    expect(out).toMatchObject({ suiteId: "drf_1", status: "ready", costUsd: 0.25 });
    expect(out.preview.scenarios).toHaveLength(2);
    expect(out.preview.scenarios[1].gateReasons).toEqual(["r1", "r2"]);
    expect(out.preview.scenarios[1].goal.length).toBeLessThan(310);
  });
  it("omits the preview while generating and shows errors", async () => {
    const { call } = setup(makeEngine({ getDraft: vi.fn(async () => draft({ status: "failed", error: "boom" })) }));
    const out = data(await call("sandbox_status", { suiteId: "drf_1" }));
    expect(out.preview).toBeUndefined();
    expect(out.error).toBe("boom");
  });
  it("returns run progress for runId", async () => {
    const { call, engine } = setup();
    const out = data(await call("sandbox_status", { runId: "run_1" }));
    expect(engine.getRunReport).toHaveBeenCalledWith("c1", "run_1");
    expect(out).toMatchObject({ runId: "run_1", status: "complete", trialsCompleted: 2, trialsTotal: 2, costUsd: 1.5 });
  });
  it("treats foreign/missing as Not found", async () => {
    const { call } = setup(makeEngine({ getDraft: vi.fn(async () => null), getRunReport: vi.fn(async () => null) }));
    for (const a of [{ suiteId: "s" }, { runId: "r" }]) {
      const r = await call("sandbox_status", a);
      expect(r.isError).toBe(true);
      expect(data(r).error).toBe("Not found");
    }
  });
});

describe("sandbox_run", () => {
  it("starts a validated-only run by default", async () => {
    const { call, engine } = setup();
    const out = data(await call("sandbox_run", { environmentId: "env_1", suiteId: "drf_1" }));
    expect(engine.startRun).toHaveBeenCalledWith("c1", "drf_1", { k: 5, scenarioIds: undefined, validatedOnly: true });
    expect(out).toMatchObject({ runId: "run_1", status: "queued", k: 5 });
  });
  it("uses explicit scenarioIds without validatedOnly", async () => {
    const { call, engine } = setup();
    await call("sandbox_run", { environmentId: "env_1", suiteId: "drf_1", k: 10, scenarioIds: ["sx_b"] });
    expect(engine.startRun).toHaveBeenCalledWith("c1", "drf_1", { k: 10, scenarioIds: ["sx_b"], validatedOnly: false });
  });
  it("rejects a suite from another environment", async () => {
    const { call, engine } = setup();
    const r = await call("sandbox_run", { environmentId: "env_other", suiteId: "drf_1" });
    expect(data(r).error).toBe("Suite not found");
    expect(engine.startRun).not.toHaveBeenCalled();
  });
  it("rejects a missing/foreign suite", async () => {
    const { call } = setup(makeEngine({ getDraft: vi.fn(async () => null) }));
    expect(data(await call("sandbox_run", { environmentId: "env_1", suiteId: "drf_1" })).error).toBe("Suite not found");
  });
  it("carries engine errors into tool errors", async () => {
    const { call } = setup(makeEngine({ startRun: vi.fn(async () => ({ ok: false, status: 429, error: "2 runs in progress" })) }));
    const r = await call("sandbox_run", { environmentId: "env_1", suiteId: "drf_1" });
    expect(r.isError).toBe(true);
    expect(data(r).error).toBe("2 runs in progress");
  });
});

describe("sandbox_report", () => {
  it("refuses unfinished runs", async () => {
    for (const status of ["queued", "running"]) {
      const { call } = setup(makeEngine({ getRunReport: vi.fn(async () => report(status)) }));
      const r = await call("sandbox_report", { runId: "run_1" });
      expect(r.isError).toBe(true);
      expect(data(r).error).toBe("Run not finished; poll sandbox_status");
    }
  });
  it("returns a compact report without transcripts beyond one clipped excerpt", async () => {
    const { call } = setup();
    const r = await call("sandbox_report", { runId: "run_1" });
    const out = data(r);
    expect(out.reportUrl).toBe("https://x.test/sandbox/runs/run_1");
    expect(out.summary).toMatchObject({ scenarios: 1, passAt1: 0.5, passHatK: 0 });
    expect(out.summary.ci95).toHaveLength(2);
    expect(out.workflows[0]).toMatchObject({ id: "wf", name: "Refunds", passRate: 0.5 });
    const s = out.scenarios[0];
    expect(s).toMatchObject({ id: "sx_a", title: "Refund ok", category: "happy_path", passHatK: false });
    expect(s.failedChecks[0]).toMatchObject({ id: "ck1", policyRef: "refund.1" });
    expect(s.failedChecks[0].detail.length).toBeLessThanOrEqual(203);
    expect(out.clusters[0]).toMatchObject({ id: "cl", policyRef: "refund.1" });
    expect(out.exampleFailure.lastTurns).toHaveLength(3);
    expect(out.exampleFailure.lastTurns[0].content.length).toBeLessThanOrEqual(303);
    expect(out.costUsd).toBe(1.5);
    expect(r.content[0].text).not.toContain("TOOLCALL");
    expect(r.content[0].text).not.toContain("DIFF");
  });
  it("is not found for foreign runs", async () => {
    const { call } = setup(makeEngine({ getRunReport: vi.fn(async () => null) }));
    expect(data(await call("sandbox_report", { runId: "run_x" })).error).toBe("Not found");
  });
});

describe("error mapping", () => {
  it("maps SandboxInputError to its message and field", async () => {
    const { call } = setup(makeEngine({ generateSuite: vi.fn(async () => { throw new SandboxInputError("You already have 2 suites generating.", 429); }) }));
    const r = await call("sandbox_generate_suite", { environmentId: "env_1" });
    expect(r.isError).toBe(true);
    expect(data(r).error).toBe("You already have 2 suites generating.");
  });
  it("hides unexpected errors behind Internal error without logging inputs", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { call } = setup(makeEngine({ createEnvironment: vi.fn(async () => { throw new Error(`db down ${SECRET_POLICY}`); }) }));
    const r = await call("sandbox_create_environment", { name: "n", openapi: SECRET_SPEC, agent });
    expect(data(r).error).toBe("Internal error");
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET_SPEC);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET_POLICY);
    spy.mockRestore();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { miniEnv } from "@ae/core/sandbox/engine/testing/fixtures";
import { buildSandboxTools, createMcpSandboxService, validateToolInput } from "./mcp-sandbox-tools";
import type { McpCaller } from "./mcp-tools";
import { createEngineSandboxService } from "./sandbox/engine-service";
import { OWNER_A, OWNER_B, createMemoryStore, type MemoryStore } from "./sandbox/memory-store.testing";

const callerA: McpCaller = { customerId: OWNER_A, email: "a@b.co", origin: "https://x.test" };
const callerB: McpCaller = { ...callerA, customerId: OWNER_B };

let m: MemoryStore;
let call: (c: McpCaller, args: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

async function addRun(ownerId: string, id: string, minute: number, status = "complete", model = "openai/gpt-5-mini") {
  const env = await m.store.insertEnvironment({
    id: `env_${id}`, ownerId, name: `Env ${id}`, domain: "", source: "custom", warnings: [],
    spec: { ...miniEnv, integration: { mode: "tool_loop", endpointUrl: "https://agent.example.com/v1", model } },
  });
  await m.store.insertRun({
    id, ownerId, environmentId: env.id, status, k: 3, scenarios: [{}, {}], budgetMicroUsd: 1, trialsTotal: 6,
    passAt1: 0.8, passHatK: 0.5, createdAt: new Date(Date.UTC(2026, 5, 1, 0, minute)),
  } as never);
}
const ids = (r: { content: Array<{ text: string }> }) => (JSON.parse(r.content[0].text).runs as Array<{ runId: string }>).map((x) => x.runId);
const body = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

beforeEach(() => {
  m = createMemoryStore();
  const engine = createEngineSandboxService({
    store: m.store, executor: { startSuite: vi.fn(), startRun: vi.fn(), startBriefScenario: vi.fn() } as never,
    checkTarget: vi.fn(async () => null), runBudgetMicroUsd: 1, suiteBudgetMicroUsd: 1, sampleReport: async () => null,
  });
  const tool = buildSandboxTools(createMcpSandboxService(engine)).find((t) => t.name === "sandbox_list_runs")!;
  call = async (c, args) => {
    const v = validateToolInput(tool, args);
    return (v.ok ? tool.run(c, v.value as never) : v.result) as never;
  };
});

describe("sandbox_list_runs authz", () => {
  it("never returns another owner's runs, and a foreign cursor cannot widen the scope", async () => {
    await addRun(OWNER_A, "run_a1", 1);
    await addRun(OWNER_B, "run_b1", 2);
    await addRun(OWNER_B, "run_b2", 3);
    expect(ids(await call(callerA, {}))).toEqual(["run_a1"]);
    expect(ids(await call(callerB, {}))).toEqual(["run_b2", "run_b1"]);
    const bPage = body(await call(callerB, { limit: 1 }));
    expect(ids(await call(callerA, { cursor: bPage.nextCursor }))).toEqual(["run_a1"]);
  });
  it("applies the status filter within the caller's runs only", async () => {
    await addRun(OWNER_A, "run_a1", 1, "failed");
    await addRun(OWNER_A, "run_a2", 2, "complete");
    await addRun(OWNER_B, "run_b1", 3, "failed");
    expect(ids(await call(callerA, { status: "failed" }))).toEqual(["run_a1"]);
  });
  it("returns the documented fields with a run-page URL", async () => {
    await addRun(OWNER_A, "run_a1", 1);
    const [run] = body(await call(callerA, {})).runs;
    expect(run).toMatchObject({
      runId: "run_a1", name: "Env run_a1", targetModel: "openai/gpt-5-mini", status: "complete", k: 3, passAt1: 0.8, passHatK: 0.5,
      url: "https://x.test/sandbox/runs/run_a1",
    });
    expect(run.createdAt).toBe("2026-06-01T00:01:00.000Z");
  });
});

describe("sandbox_list_runs pagination", () => {
  it("walks pages newest-first without gaps or duplicates and ends with a null cursor", async () => {
    for (let i = 1; i <= 5; i++) await addRun(OWNER_A, `run_${i}`, i);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = body(await call(callerA, { limit: 2, ...(cursor ? { cursor } : {}) }));
      seen.push(...page.runs.map((r: { runId: string }) => r.runId));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["run_5", "run_4", "run_3", "run_2", "run_1"]);
  });
  it("gives a null cursor when everything fits on one page", async () => {
    await addRun(OWNER_A, "run_1", 1);
    expect(body(await call(callerA, { limit: 1 })).nextCursor).toBeNull();
  });
  it("defaults the limit to 20 and rejects limits over 100, junk cursors and bad statuses", async () => {
    for (let i = 1; i <= 25; i++) await addRun(OWNER_A, `run_${i}`, i);
    expect(ids(await call(callerA, {}))).toHaveLength(20);
    for (const bad of [{ limit: 101 }, { limit: 0 }, { cursor: "x'; drop table" }, { status: "nope" }]) {
      expect((await call(callerA, bad)).isError).toBe(true);
    }
    expect(ids(await call(callerA, { limit: 100 }))).toHaveLength(25);
  });
});

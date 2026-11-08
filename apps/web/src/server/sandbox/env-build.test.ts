import { describe, expect, it } from "vitest";
import type { IntegrationMode } from "@ae/core/sandbox/spec";
import type { SandboxIntakeInput } from "@/components/sandbox/contract";
import { buildCustom, buildFromIntake, buildPrebuilt } from "./env-build";
import { SandboxInputError } from "./target";

const integration: IntegrationMode = { mode: "tool_loop", endpointUrl: "https://agent.example.com/v1/chat/completions", model: "m" };
const fns = [
  { name: "get_order", description: "Get an order", parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] } },
  { name: "cancel_order", description: "Cancel an order", parameters: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] } },
];
const intake = (over: Record<string, unknown>): SandboxIntakeInput => ({ name: "Shop Bot", domain: "retail", integration, ...over } as SandboxIntakeInput);
const world = (over: Record<string, unknown> = {}) => ({
  tools: { format: "function_json", content: JSON.stringify(fns) },
  data: { format: "infer", content: "" },
  policies: [{ title: "Cancellations", text: "Orders may be cancelled before shipping." }],
  workflowNotes: "",
  ...over,
});
const reject = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: unknown) => e)) as SandboxInputError;

describe("buildPrebuilt", () => {
  it("builds acme-support with the supplied integration", async () => {
    const b = await buildPrebuilt("acme-support", integration);
    expect(b).toMatchObject({ source: "prebuilt", prebuiltId: "acme-support" });
    expect(b.spec.tools.length).toBeGreaterThan(3);
    expect(b.spec.integration).toMatchObject({ mode: "tool_loop", model: "m" });
    expect(b.spec.workflows.length).toBeGreaterThan(0);
  });

  it("rejects unknown ids with a field", async () => {
    const e = await reject(buildPrebuilt("nope", integration));
    expect(e).toBeInstanceOf(SandboxInputError);
    expect(e).toMatchObject({ status: 422, field: "prebuilt" });
  });

  it("rejects non-runnable integrations", async () => {
    const e = await reject(buildPrebuilt("acme-support", { mode: "staging", chatEndpointUrl: "https://x.example.com/c" } as never));
    expect(e).toMatchObject({ field: "integration.mode" });
  });
});

describe("buildCustom", () => {
  it("builds a function_json world with a stub DDL and a warning when no DDL is given", async () => {
    const b = await buildCustom({ name: "Shop Bot", domain: "retail", functions: fns, policies: [{ title: "Cancellations", text: "Cancel before shipping." }] }, integration);
    expect(b).toMatchObject({ source: "custom", prebuiltId: null });
    expect(b.spec.tools.map((t) => t.name)).toEqual(["get_order", "cancel_order"]);
    expect(b.spec.state.ddl).toContain("world_notes");
    expect(b.warnings.some((w) => w.includes("No database schema"))).toBe(true);
    expect(b.spec.workflows).toHaveLength(1);
    expect(b.spec.workflows[0]!.tools).toEqual(["get_order", "cancel_order"]);
    expect(b.spec.policies.length).toBeGreaterThan(0);
  });

  it("uses the customer's DDL (no stub, no warning) and custom workflows filtered to known tools", async () => {
    const ddl = "CREATE TABLE orders (id text primary key, status text);";
    const b = await buildCustom({
      name: "Shop Bot", domain: "retail", functions: fns, ddl, policies: [],
      workflows: [{ name: "Cancel flow", description: "Cancel an order", tools: ["cancel_order", "ghost_tool"] }],
    }, integration);
    expect(b.spec.state.ddl).toContain("CREATE TABLE orders");
    expect(b.spec.state.ddl).not.toContain("world_notes");
    expect(b.warnings.some((w) => w.includes("No database schema"))).toBe(false);
    expect(b.spec.workflows[0]).toMatchObject({ id: "cancel_flow", tools: ["cancel_order"] });
  });

  it("rejects when no tools are defined", async () => {
    const e = await reject(buildCustom({ name: "X", domain: "", functions: [], policies: [] }, integration));
    expect(e).toMatchObject({ status: 422, field: "world.tools.content" });
  });

  it("rejects unparseable tools with the content field", async () => {
    const e = await reject(buildCustom({ name: "X", domain: "", functions: { not: "an array of functions" }, policies: [] }, integration));
    expect(e).toBeInstanceOf(SandboxInputError);
    expect(e.field).toBe("world.tools.content");
  });

  it("rejects non-runnable integrations before parsing", async () => {
    const e = await reject(buildCustom({ name: "X", domain: "", functions: fns, policies: [] }, { mode: "staging", chatEndpointUrl: "https://x.example.com/c" } as never));
    expect(e).toMatchObject({ field: "integration.mode" });
  });
});

describe("buildFromIntake", () => {
  it("prebuilt: applies the user's name to the spec", async () => {
    const b = await buildFromIntake(intake({ prebuilt: "acme-support", name: "My Acme" }));
    expect(b.prebuiltId).toBe("acme-support");
    expect(b.spec.name).toBe("My Acme");
  });

  it("custom function_json world builds end to end", async () => {
    const b = await buildFromIntake(intake({ world: world() }));
    expect(b.source).toBe("custom");
    expect(b.spec.name).toBe("Shop Bot");
    expect(b.spec.tools).toHaveLength(2);
  });

  it("rejects CSV data with world.data.format", async () => {
    const e = await reject(buildFromIntake(intake({ world: world({ data: { format: "csv", content: "a,b\n1,2" } }) })));
    expect(e).toMatchObject({ status: 422, field: "world.data.format" });
    expect(e.message).toContain("CSV");
  });

  it("rejects invalid JSON tool definitions with world.tools.content", async () => {
    const e = await reject(buildFromIntake(intake({ world: world({ tools: { format: "function_json", content: "{not json" } }) })));
    expect(e).toMatchObject({ status: 422, field: "world.tools.content" });
    expect(e.message).toContain("valid JSON");
  });

  it("rejects an intake with neither prebuilt nor world", async () => {
    const e = await reject(buildFromIntake(intake({})));
    expect(e).toMatchObject({ field: "world" });
  });
});

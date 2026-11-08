import { describe, expect, it, vi } from "vitest";
import { SANDBOX_TOOLS, buildSandboxTools, validateToolInput, type SandboxService } from "./mcp-sandbox-tools";
import type { McpCaller, McpToolResult } from "./mcp-tools";

const caller: McpCaller = { customerId: "c1", email: "a@b.co", origin: "https://x.test" };
const agent = { endpointUrl: "https://agent.example.com/v1/chat/completions", model: "m" };
const tool = (name: string, tools = SANDBOX_TOOLS) => tools.find((t) => t.name === name)!;
const call = async (name: string, args: unknown, tools = SANDBOX_TOOLS) => {
  const t = tool(name, tools);
  const v = validateToolInput(t, args);
  if (!v.ok) return v.result;
  return t.run(caller, v.value as never);
};

describe("sandbox tool input validation", () => {
  it("rejects when no spec source is given", async () => {
    const r = await call("sandbox_create_environment", { name: "n", agent });
    expect(r.isError).toBe(true);
  });
  it("rejects a non-https or malformed agent URL", async () => {
    for (const endpointUrl of ["http://agent.example.com", "not a url"]) {
      const r = await call("sandbox_create_environment", { name: "n", openapi: "openapi: 3.0.0", agent: { ...agent, endpointUrl } });
      expect(r.isError).toBe(true);
    }
  });
  it("rejects oversized openapi and an apiKeyRef that looks like a secret with spaces", async () => {
    expect((await call("sandbox_create_environment", { name: "n", openapi: "x".repeat(500_001), agent })).isError).toBe(true);
    expect((await call("sandbox_create_environment", { name: "n", openapi: "a", agent: { ...agent, apiKeyRef: "sk live key" } })).isError).toBe(true);
  });
  it("bounds k to 1..10", async () => {
    for (const k of [0, 11, 1.5]) expect((await call("sandbox_run", { environmentId: "e", suiteId: "s", k })).isError).toBe(true);
  });
  it("defaults k", () => {
    const v = validateToolInput(tool("sandbox_run"), { environmentId: "e", suiteId: "s" });
    expect(v.ok && (v.value as { k: number }).k).toBe(5);
  });
});

describe("coming-soon stub", () => {
  it("returns coming_soon, no error, no fabricated ids, no content echo", async () => {
    const secretish = "SECRET_MARKER_" + "y".repeat(1000);
    const r = await call("sandbox_create_environment", { name: "n", functions: [{ name: "f" }], policies: [secretish], agent });
    expect(r.isError).toBeUndefined();
    const s = r.structuredContent as Record<string, unknown>;
    expect(s.status).toBe("coming_soon");
    expect(s).not.toHaveProperty("environmentId");
    expect(JSON.stringify(r)).not.toContain("SECRET_MARKER_");
    expect((s.received as { policies: number }).policies).toBe(1);
  });
  it("other tools are coming_soon without ids", async () => {
    for (const [n, a] of [["sandbox_generate_suite", { environmentId: "e" }], ["sandbox_run", { environmentId: "e", suiteId: "s", k: 2 }], ["sandbox_status", { runId: "r" }], ["sandbox_report", { runId: "r" }]] as const) {
      const r = await call(n, a);
      expect(r.isError).toBeUndefined();
      expect(r.structuredContent).toMatchObject({ status: "coming_soon" });
      expect(r.structuredContent).not.toHaveProperty("suiteId");
      expect(r.structuredContent).not.toHaveProperty("scenarios");
    }
  });
});

describe("buildSandboxTools", () => {
  it("delegates to the injected service with the caller", async () => {
    const res = (d: string): McpToolResult => ({ content: [{ type: "text", text: d }] });
    const service: SandboxService = {
      createEnvironment: vi.fn(() => res("env")), generateSuite: vi.fn(() => res("suite")),
      run: vi.fn(() => res("run")), status: vi.fn(() => res("st")), report: vi.fn(() => res("rep")),
    };
    const tools = buildSandboxTools(service);
    expect(tools.map((t) => t.name)).toEqual(["sandbox_create_environment", "sandbox_generate_suite", "sandbox_run", "sandbox_status", "sandbox_report"]);
    await call("sandbox_create_environment", { name: "n", mcpTools: "[]".padEnd(3, " "), agent }, tools);
    await call("sandbox_generate_suite", { environmentId: "e1" }, tools);
    await call("sandbox_run", { environmentId: "e1", suiteId: "s1", k: 3 }, tools);
    await call("sandbox_status", { runId: "r1" }, tools);
    await call("sandbox_report", { runId: "r1" }, tools);
    expect(service.createEnvironment).toHaveBeenCalledWith(caller, expect.objectContaining({ name: "n" }));
    expect(service.generateSuite).toHaveBeenCalledWith(caller, "e1");
    expect(service.run).toHaveBeenCalledWith(caller, "e1", "s1", 3);
    expect(service.status).toHaveBeenCalledWith(caller, "r1");
    expect(service.report).toHaveBeenCalledWith(caller, "r1");
  });
});

describe("descriptions", () => {
  it("create_environment tells agents which files to find and to send contents", () => {
    const d = tool("sandbox_create_environment").description;
    for (const needle of ["openapi.yaml", "swagger", "tools.ts", "prisma/schema.prisma", "Drizzle", "migrations", "seed", "docs/policies/*.md", "POLICY*.md", "playbooks", "CONTENTS", "secrets", "apiKeyRef"]) {
      expect(d).toContain(needle);
    }
  });
  it("every tool has a description and every field is described", () => {
    for (const t of SANDBOX_TOOLS) {
      expect(t.description.length).toBeGreaterThan(40);
      for (const [k, s] of Object.entries(t.inputSchema.shape)) expect((s as { description?: string }).description, `${t.name}.${k}`).toBeTruthy();
    }
  });
  it("suite generation description mentions the spec files too", () => {
    expect(tool("sandbox_generate_suite").description).toMatch(/openapi\.yaml/);
  });
});

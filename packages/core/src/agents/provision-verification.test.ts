// Offline schema fixtures through the real SDK 0.12.3 injected fetch; no provider calls.
import { createClient } from "@usenaive-sdk/managed-agents";
import { describe, expect, it } from "vitest";
import type { AgentRole } from "../evals/types";
import { AgentProvisioningError, buildAgentCreateBody, ensureAgents } from "./provision";

const roles: AgentRole[] = ["commercial", "evaluation_engineer", "quality_investigator", "company_operator"];
const stamp = "2026-11-07T20:00:00.000Z";
const id = (n: number) => `agt_${String(n).padStart(26, "0")}`;
const agent = (role: AgentRole, n: number, over = {}) => ({
  ...buildAgentCreateBody(role), id: id(n), object: "agent", harness: "vetta",
  current_version: 3, created_at: stamp, output_schema: null, structured_output_required: false, ...over,
});
const version = (a: ReturnType<typeof agent>, over = {}) => {
  const { id: _id, name: _name, object: _object, harness: _harness, current_version, ...config } = a;
  return { ...config, version: current_version, created_by: { type: "system", id: "fixture" }, ...over };
};
const page = (data: unknown[], has_more = false, next_cursor: string | null = null) => ({ data, has_more, next_cursor });
function harness(handler: (path: string, method: string, body: unknown) => unknown) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const client = createClient({ apiKey: "fixture-not-a-secret", baseUrl: "https://naive.invalid", fetch: (async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    return new Response(JSON.stringify(handler(path, method, body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch });
  return { client, calls };
}
function existing(over: Record<string, unknown> = {}, versionOver: Record<string, unknown> = {}) {
  const agents = roles.map((r, n) => agent(r, n + 1));
  const h = harness((path) => {
    if (path === "/v1/agents") return page(agents);
    const a = agents.find((a) => path.includes(a.id))!;
    return path.includes("/versions/") ? version(a, versionOver) : { ...a, ...over };
  });
  return { ...h, agents };
}
async function diagnostic(promise: ReturnType<typeof ensureAgents>) {
  try { await promise; throw new Error("unexpected success"); }
  catch (error) { expect(error).toBeInstanceOf(AgentProvisioningError); return error as AgentProvisioningError; }
}

describe("bounded agent provisioning verification", () => {
  it("reads each identity and exact version and pins all four roles", async () => {
    const h = existing();
    const result = await ensureAgents(h.client);
    expect(result.created).toEqual([]);
    expect(Object.keys(result.directory)).toEqual(roles);
    expect(result.directory.commercial).toEqual({ agentId: id(1), agentVersion: 3 });
    expect(h.calls).toHaveLength(9);
    expect(h.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("verifies a configured old pin without advancing it", async () => {
    const h = existing({}, { version: 2 });
    const directory = Object.fromEntries(roles.map((r, n) => [r, { agentId: id(n + 1), agentVersion: 2 }]));
    expect((await ensureAgents(h.client, { directory })).directory).toEqual(directory);
    expect(h.calls.filter((c) => c.path.includes("versions")).every((c) => c.path.endsWith("/2"))).toBe(true);
  });
  it.each([
    { model_selection: { options: { model_a: "simple", model_b: "complex" } } },
    { model: "altered" }, { system: "altered" }, { description: "altered" }, { window: "priority" },
    { tools: { default_config: { permission: "allow" }, configs: {} } },
    { tools: { default_config: { permission: "deny" }, configs: { bash: { permission: "allow" } } } },
    { tools: { default_config: { permission: "deny" }, configs: { bash: { permission: "deny" } } } },
    { mcp_servers: [{ name: "external", url: "https://example.invalid" }] }, { skills: ["test"] },
    { multiagent: true }, { handoffs: true }, { handoffs: [] },
    { metadata: { ae_role: "company_operator", ae_managed: true } }, { metadata: {} },
    { budget: { cap_micro_usd: 1, max_task_micro_usd: 1, period: "month" } },
    { budget: { cap_micro_usd: 35000000, max_task_micro_usd: 1000000, period: "day" } },
  ])("denies changed exact-version configuration %j", async (change) => {
    const h = existing({}, change);
    const err = await diagnostic(ensureAgents(h.client));
    expect(["configuration_mismatch", "attestation_unavailable"]).toContain(err.diagnostic.code);
    expect(h.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("reports missing handoffs attestation instead of assuming disabled", async () => {
    const h = existing({}, { handoffs: undefined });
    expect((await diagnostic(ensureAgents(h.client))).diagnostic).toMatchObject({ code: "attestation_unavailable", fields: ["handoffs"] });
  });
  it("dry run still refuses unsafe existing agents", async () => {
    const h = existing({}, { handoffs: true });
    expect((await diagnostic(ensureAgents(h.client, { dryRun: true }))).diagnostic.code).toBe("configuration_mismatch");
    expect(h.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects unpinned/invalid configured versions %s", async (agentVersion) => {
    const h = existing();
    expect((await diagnostic(ensureAgents(h.client, { directory: { commercial: { agentId: id(1), agentVersion } } }))).diagnostic.code).toBe("invalid_options");
    expect(h.calls).toHaveLength(0);
  });
  it("checks custom requested model exactly", async () => {
    const h = existing();
    expect((await diagnostic(ensureAgents(h.client, { model: "custom-model" }))).diagnostic.code).toBe("configuration_mismatch");
  });
  it.each([{ id: id(9) }, { name: "CEO" }])("rejects identity substitution %j", async (change) => {
    const h = existing(change);
    expect((await diagnostic(ensureAgents(h.client))).diagnostic.code).toBe("identity_mismatch");
  });
  it("rejects a different returned exact version", async () => {
    const h = existing({}, { version: 9 });
    expect((await diagnostic(ensureAgents(h.client))).diagnostic.code).toBe("identity_mismatch");
  });
  it("rejects a configured ID absent from discovery", async () => {
    const h = existing();
    expect((await diagnostic(ensureAgents(h.client, { directory: { commercial: { agentId: id(9), agentVersion: 1 } } }))).diagnostic.code).toBe("identity_mismatch");
    expect(h.calls).toHaveLength(1);
  });
  it("rejects duplicate role names across pages before creating missing roles", async () => {
    let n = 0;
    const h = harness(() => ++n === 1 ? page([agent("commercial", 1)], true, "next") : page([agent("commercial", 2)]));
    expect((await diagnostic(ensureAgents(h.client))).diagnostic.code).toBe("duplicate_role");
    expect(h.calls).toHaveLength(2);
  });
  it.each([page([], true), page([], false, "unexpected"), page([], true, "")])("rejects inconsistent pagination %j", async (response) => {
    const h = harness(() => response);
    expect((await diagnostic(ensureAgents(h.client))).diagnostic.code).toBe("incomplete_listing");
    expect(h.calls).toHaveLength(1);
  });
  it("bounds pagination at 20 pages", async () => {
    let n = 0;
    const h = harness(() => page([], true, `cursor-${++n}`));
    expect((await diagnostic(ensureAgents(h.client))).diagnostic.code).toBe("incomplete_listing");
    expect(h.calls).toHaveLength(20);
  });
  it("rejects repeated cursors and overlapping records", async () => {
    for (const data of [[], [agent("commercial", 1)]]) {
      const h = harness(() => page(data, true, "same"));
      expect((await diagnostic(ensureAgents(h.client))).diagnostic.code).toBe("incomplete_listing");
      expect(h.calls).toHaveLength(2);
    }
  });
  it("preserves CEO and unrelated agents and dry run creates nothing", async () => {
    const h = harness(() => page([{ ...agent("commercial", 8), name: "CEO" }]));
    expect(await ensureAgents(h.client, { dryRun: true })).toEqual({ directory: {}, created: [], missing: roles });
    expect(h.calls).toHaveLength(1);
  });
  it("creates only missing roles, checks acknowledgements and reads exact versions", async () => {
    let n = 0;
    const stored: ReturnType<typeof agent>[] = [];
    const h = harness((path, method, body) => {
      if (method === "POST") { const a = agent(roles[n]!, ++n, body as object); stored.push(a); return a; }
      if (path === "/v1/agents") return page([]);
      return version(stored.find((a) => path.includes(a.id))!);
    });
    const result = await ensureAgents(h.client);
    expect(result.created).toEqual(roles);
    expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(4);
    expect(h.calls.filter((c) => c.path.includes("versions"))).toHaveLength(4);
    expect(h.calls.every((c) => ["GET", "POST"].includes(c.method))).toBe(true);
  });
  it("retains creation identity for reconciliation on altered response, without retry", async () => {
    const h = harness((_, method) => method === "POST" ? agent("commercial", 1, { handoffs: true }) : page([]));
    const err = await diagnostic(ensureAgents(h.client));
    expect(err.diagnostic).toMatchObject({ code: "configuration_mismatch", phase: "creation" });
    expect(err.created.commercial).toEqual({ agentId: id(1), agentVersion: 3 });
    expect(h.calls).toHaveLength(2);
  });
  it("retains a created ID when exact-version inspection fails", async () => {
    const h = harness((path, method) => {
      if (method === "POST") return agent("commercial", 1);
      if (path.includes("versions")) throw new Error("hostile-provider-secret");
      return page([]);
    });
    const err = await diagnostic(ensureAgents(h.client));
    expect(err.diagnostic.code).toBe("creation_uncertain");
    expect(err.created.commercial).toEqual({ agentId: id(1), agentVersion: 3 });
    expect(h.calls).toHaveLength(3);
    expect(JSON.stringify(err)).not.toContain("hostile-provider-secret");
  });
  it("accepts an exact custom model on existing versions", async () => {
    const h = existing({}, { model: "custom-model" });
    expect(Object.keys((await ensureAgents(h.client, { model: "custom-model" })).directory)).toEqual(roles);
  });
  it("accepts a complete final twentieth page", async () => {
    let n = 0;
    const h = harness(() => ++n < 20 ? page([], true, `cursor-${n}`) : page([]));
    expect((await ensureAgents(h.client, { dryRun: true })).missing).toEqual(roles);
    expect(h.calls).toHaveLength(20);
  });
  it.each([false, true])("sanitizes malformed SDK responses (creation=%s)", async (create) => {
    const h = harness((_, method) => !create || method === "POST" ? { secret: "provider-secret" } : page([]));
    const err = await diagnostic(ensureAgents(h.client));
    expect(err.diagnostic.code).toBe(create ? "creation_uncertain" : "inspection_failed");
    expect(JSON.stringify(err)).not.toContain("provider-secret");
    expect(err.cause).toBeUndefined();
  });
});

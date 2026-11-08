import { describe, expect, it } from "vitest";
import { AgentProvisioningError, attestAgentConfiguration, buildAgentCreateBody, type ExpectedAgentConfiguration } from "./provision";

function expected(): ExpectedAgentConfiguration {
  return {
    ...buildAgentCreateBody("commercial"),
    metadata: { ae_role: "future_coordinator", ae_managed: true },
    tools: { default_config: { permission: "deny" }, configs: {
      web_search: { permission: "allow", config: { allowed_domains: ["example.test"], max_content_tokens: 100 } },
      email: { enabled: true, permission: "ask" }, bash: { enabled: false, permission: "deny" },
    } },
    mcp_servers: [{ name: "evaluation", url: "https://mcp.example.test" }], skills: ["evaluation-v1"],
    multiagent: { type: "coordinator", agents: [{ type: "agent", id: "agt_fixture", version: 3 }], board: false },
    handoffs: "team",
  };
}
function rejected(change: (actual: any) => void, field: string) {
  const wanted = expected(), actual = structuredClone(wanted);
  change(actual);
  try { attestAgentConfiguration(actual, wanted); throw new Error("unexpected success"); }
  catch (error) {
    expect(error).toBeInstanceOf(AgentProvisioningError);
    expect((error as AgentProvisioningError).diagnostic.fields).toContain(field);
    return error as AgentProvisioningError;
  }
}

describe("exact tool-bearing role attestation", () => {
  it("accepts exact future-role config and provider-only fields", () => {
    const wanted = expected();
    attestAgentConfiguration({ ...wanted, id: "provider-id", version: 8, created_at: "timestamp", metadata: { ...wanted.metadata, provider_tag: "extra" } }, wanted);
  });
  it("accepts SDK enabled=true materialization and reordered object keys", () => {
    const wanted = expected(), actual = structuredClone(wanted);
    actual.tools.configs.web_search = { config: { max_content_tokens: 100, allowed_domains: ["example.test"] }, permission: "allow", enabled: true };
    attestAgentConfiguration(actual, wanted);
  });
  it.each(["allow", "ask", "deny"] as const)("rejects changed %s tool permission", (permission) => {
    rejected((a) => { a.tools.configs.web_search.permission = permission === "allow" ? "ask" : permission; }, "tools");
  });
  it.each([
    (a: any) => { a.tools.default_config.permission = "ask"; },
    (a: any) => { a.tools.default_config.extra = true; },
    (a: any) => { a.tools.extra = true; },
    (a: any) => { a.tools.configs.web_search.enabled = false; },
    (a: any) => { a.tools.configs.web_search.extra = true; },
    (a: any) => { a.tools.configs.web_search.config.allowed_domains = []; },
    (a: any) => { a.tools.configs.web_search.config.extra = true; },
    (a: any) => { a.tools.configs.extra_tool = { permission: "deny" }; },
    (a: any) => { delete a.tools.configs.email; },
  ])("rejects tool config drift and unknown additions", (change) => { rejected(change, "tools"); });
  it.each([
    ["mcp_servers", (a: any) => { a.mcp_servers.push({ name: "extra", url: "https://extra.test" }); }],
    ["mcp_servers", (a: any) => { a.mcp_servers[0].name = "changed"; }],
    ["mcp_servers", (a: any) => { a.mcp_servers[0].url = "https://changed.test"; }],
    ["mcp_servers", (a: any) => { a.mcp_servers[0].headers = { Authorization: "secret-sentinel" }; }],
    ["skills", (a: any) => { a.skills.push("extra"); }],
    ["multiagent", (a: any) => { a.multiagent.agents[0].version = 4; }],
    ["multiagent", (a: any) => { a.multiagent.board = true; }],
    ["multiagent", (a: any) => { a.multiagent.extra = true; }],
    ["handoffs", (a: any) => { a.handoffs = true; }],
    ["model", (a: any) => { a.model = "other"; }],
    ["model_selection", (a: any) => { a.model_selection = { options: { other: "all" } }; }],
    ["system", (a: any) => { a.system = "other"; }],
    ["metadata", (a: any) => { a.metadata.ae_role = "other"; }],
    ["budget", (a: any) => { a.budget.max_task_micro_usd++; }],
    ["budget", (a: any) => { a.budget.extra = true; }],
  ] as const)("rejects %s safety drift", (field, change) => { rejected(change, field); });
  it("pins dynamic selection exactly when explicitly expected", () => {
    const wanted = expected(); wanted.model_selection = { options: { model_a: "simple" }, min_confidence: 0.9 };
    attestAgentConfiguration(structuredClone(wanted), wanted);
    expect(() => attestAgentConfiguration({ ...wanted, model_selection: null }, wanted)).toThrow(AgentProvisioningError);
  });
  it("retains legacy absent/null fixed selection semantics", () => {
    const wanted = expected(), actual = structuredClone(wanted); delete actual.model_selection;
    attestAgentConfiguration(actual, wanted);
  });
  it("missing handoffs never attests disabled", () => {
    const error = rejected((a) => { delete a.handoffs; }, "handoffs");
    expect(error.diagnostic.code).toBe("attestation_unavailable");
  });
  it("diagnostics contain only static field paths, never malicious keys or values", () => {
    const error = rejected((a) => { a.tools.configs["secret-sentinel"] = { config: { password: "secret-sentinel" } }; }, "tools");
    expect(error.diagnostic.fields).toEqual(["tools"]);
    expect(JSON.stringify(error) + error.message).not.toContain("secret-sentinel");
  });
});

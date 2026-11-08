import { describe, expect, it } from "vitest";
import { buildCompanyAgentCreateBody, COMPANY_ROLE_DEFINITIONS, type CompanyAgentOptions, type CompanyRole } from "./company-roles";
const options: CompanyAgentOptions = {
  internalMcpUrl: "https://example.com/api/mcp/internal",
  skillIds: Object.fromEntries(["se-house-rules", "se-pricing-menu", "se-eval-taxonomy", "se-tau2-patterns"].map(name => [name, `${name}@1`])),
  coordinatorAgents: Object.fromEntries(["market_researcher", "prospector", "outreach", "onboarding"].map((name, i) => [name, { agentId: `agt_${String(i).repeat(26)}`, agentVersion: 1 }])) as CompanyAgentOptions["coordinatorAgents"],
};
describe("company desired configuration safety", () => {
  it("freezes nested definitions, budgets, permissions and schedules", () => {
    for (const def of Object.values(COMPANY_ROLE_DEFINITIONS)) {
      expect(Object.isFrozen(def)).toBe(true);
      expect(Object.isFrozen(def.tools)).toBe(true);
      expect(Object.isFrozen(def.skillNames)).toBe(true);
      if (def.deployment) expect(Object.isFrozen(def.deployment)).toBe(true);
    }
    expect(() => { COMPANY_ROLE_DEFINITIONS.outreach.maxTaskMicroUsd = 99_000_000; }).toThrow();
    expect(() => { COMPANY_ROLE_DEFINITIONS.planner.deployment!.cron = "* * * * *"; }).toThrow();
  });
  it.each(["", "   ", " skill@1", "skill@1\n", "skill\u0000ref"])("rejects malformed operator skill references", reference => {
    expect(() => buildCompanyAgentCreateBody("judge", { ...options, skillIds: { "se-house-rules": reference } })).toThrow("Missing company skill reference");
  });
  it("requires explicit scoped dependencies and denies ambient tools across the roster", () => {
    expect(Object.keys(COMPANY_ROLE_DEFINITIONS)).toHaveLength(15);
    for (const role of Object.keys(COMPANY_ROLE_DEFINITIONS) as CompanyRole[]) {
      const body = buildCompanyAgentCreateBody(role, options);
      expect(body.tools.default_config.permission).toBe("deny");
      expect(body.structured_output_required).toBe(true);
      expect(body.budget.max_task_micro_usd).toBeGreaterThanOrEqual(300_000);
      expect(body.handoffs).toBe(role === "planner" ? "team" : false);
      expect(body.tools.configs.bash).toBeUndefined();
      expect(body.mcp_servers.every(server => !server.headers)).toBe(true);
    }
  });
  it("keeps sends and customer mutations approval gated", () => {
    expect(buildCompanyAgentCreateBody("outreach", options).tools.configs["se_internal.send_outreach"]?.permission).toBe("ask");
    for (const role of ["onboarding", "owner_liaison", "leaderboard"] as const) {
      const body = buildCompanyAgentCreateBody(role, options);
      for (const [name, config] of Object.entries(body.tools.configs)) {
        if (/create|generate|sandbox_run|request_rerun|pause|visibility|opt_out|start_|escalate/.test(name)) expect(config.permission).toBe("ask");
      }
    }
  });
  it("rejects missing skills, missing team pins and duplicate team identities", () => {
    expect(() => buildCompanyAgentCreateBody("judge", { ...options, skillIds: {} })).toThrow("Missing company skill");
    expect(() => buildCompanyAgentCreateBody("planner", { ...options, coordinatorAgents: undefined })).toThrow("Missing coordinator");
    const team = options.coordinatorAgents!;
    expect(() => buildCompanyAgentCreateBody("planner", { ...options, coordinatorAgents: { ...team, outreach: team.prospector } })).toThrow("Duplicate coordinator");
  });
  it.each(["http://example.com/mcp", "https://user:secret@example.com/mcp", "https://example.com/mcp?secret=value", "https://localhost/mcp"])("rejects unsafe MCP URL %s", internalMcpUrl => {
    expect(() => buildCompanyAgentCreateBody("copilot", { ...options, internalMcpUrl })).toThrow("Invalid internal MCP URL");
  });
  it("returns detached mutable configurations", () => {
    const first = buildCompanyAgentCreateBody("outreach", options);
    first.tools.configs["se_internal.send_outreach"]!.permission = "allow";
    expect(buildCompanyAgentCreateBody("outreach", options).tools.configs["se_internal.send_outreach"]?.permission).toBe("ask");
  });
});

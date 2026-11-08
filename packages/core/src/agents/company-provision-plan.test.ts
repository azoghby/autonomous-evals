import { describe, expect, it } from "vitest";
import { buildCompanyProvisionPlan, type CompanyProvisionPlanOptions, type CompanyProvisionReceipts } from "./company-provision-plan";
import { COMPANY_SKILLS, COMPANY_OUTCOMES } from "./company-resources";
import { COMPANY_ROLE_DEFINITIONS, type CompanyRole } from "./company-roles";
import { configFingerprint } from "./naive-provisioning";
const uid = (prefix: string, n: number) => `${prefix}_${String(n).padStart(26, "0")}`;
function setup(): CompanyProvisionPlanOptions {
  const receipts: CompanyProvisionReceipts = {
    skills: Object.fromEntries(COMPANY_SKILLS.map((s, i) => [s.slug, { id: uid("skl", i), version: 1, reference: `${s.slug}@1`, sha256: s.sha256! }])),
    outcomes: Object.fromEntries(COMPANY_OUTCOMES.map((s, i) => [s.name, { id: uid("ocm", i) }])), agents: {}, vaults: {}, credentials: {},
  };
  return { stage: "agents", revision: "phase0", createRevisionAgents: true, internalMcpUrl: "https://example.com/api/mcp/internal", receipts };
}
function withAgents(): CompanyProvisionPlanOptions {
  const options = setup();
  const ops = buildCompanyProvisionPlan(options).operations;
  ops.forEach((op, i) => { if (op.kind === "agent") options.receipts!.agents![op.body.metadata.ae_role as CompanyRole] = { id: uid("agt", i), version: 3, name: op.body.name, configurationFingerprint: configFingerprint(op.body) }; });
  options.stage = "coordinator";
  const coordinator = buildCompanyProvisionPlan(options).operations[0]!;
  if (coordinator.kind !== "agent") throw Error();
  options.receipts!.agents!.planner = { id: uid("agt", 99), version: 2, name: coordinator.body.name, configurationFingerprint: configFingerprint(coordinator.body) };
  options.stage = "resources";
  const vaults = buildCompanyProvisionPlan(options).operations.filter(op => op.kind === "vault");
  const mcp = Object.values(COMPANY_ROLE_DEFINITIONS).filter(d => Object.keys(d.tools).some(k => k.startsWith("se_internal.")));
  options.credentialFiles = {}; options.schedules = {};
  mcp.forEach((def, i) => {
    const vaultId = uid("vlt", i);
    options.receipts!.vaults![def.role] = { id: vaultId, name: vaults[i]!.body.display_name };
    options.credentialFiles![def.role] = `/private/credentials/${def.role}`;
    options.receipts!.credentials![def.role] = { id: uid("vcr", i), vaultId, agentId: options.receipts!.agents![def.role]!.id, mcpUrl: options.internalMcpUrl! };
  });
  for (const def of Object.values(COMPANY_ROLE_DEFINITIONS)) if (def.deployment) options.schedules[def.role] = { cron: def.deployment.cron ?? "0 7 * * *", timezone: "America/Los_Angeles", inputTemplate: "Plan dry-run work within existing authorization.", onIdleUrl: "https://example.com/api/naive/idle" };
  return options;
}
describe("staged company provisioning plans", () => {
  it("creates resources and distinct role-bound vaults without secret input or SDK calls", () => {
    const result = buildCompanyProvisionPlan({ stage: "resources", revision: "phase0", createRevisionAgents: true });
    expect(result.operations.filter(o => o.kind === "skill")).toHaveLength(4);
    expect(result.operations.filter(o => o.kind === "outcome")).toHaveLength(3);
    expect(result.operations.filter(o => o.kind === "vault")).toHaveLength(7);
  });
  it("requires explicit new revision opt-in and never plans legacy names", () => {
    expect(() => buildCompanyProvisionPlan({ ...setup(), createRevisionAgents: false } as unknown as CompanyProvisionPlanOptions)).toThrow();
    expect(() => buildCompanyProvisionPlan({ ...setup(), revision: "../bad" })).toThrow();
    const ops = buildCompanyProvisionPlan(setup()).operations;
    expect(ops).toHaveLength(14);
    for (const op of ops) { if (op.kind !== "agent") throw Error(); expect(op.body.name).toMatch(/-phase0$/); expect(op.body.name).not.toBe(COMPANY_ROLE_DEFINITIONS[op.body.metadata.ae_role as CompanyRole].agentName); }
  });
  it("rejects missing or changed content and incorrectly retained agent receipts", () => {
    const o = setup(); delete o.receipts!.skills!["se-house-rules"]; expect(() => buildCompanyProvisionPlan(o)).toThrow();
    const unpinned = setup(); unpinned.receipts!.skills!["se-house-rules"]!.reference = "se-house-rules"; expect(() => buildCompanyProvisionPlan(unpinned)).toThrow();
    const changed = setup(); changed.receipts!.skills!["se-house-rules"]!.sha256 = "bad"; expect(() => buildCompanyProvisionPlan(changed)).toThrow();
    const stale = withAgents(); stale.stage = "agents"; stale.receipts!.agents!.commercial!.configurationFingerprint = "bad"; expect(() => buildCompanyProvisionPlan(stale)).toThrow();
  });
  it("pins Cass to exact distinct team versions and refuses missing or aliased members", () => {
    const o = withAgents(); o.stage = "coordinator";
    const op = buildCompanyProvisionPlan(o).operations[0]!;
    if (op.kind !== "agent" || !op.body.multiagent || typeof op.body.multiagent !== "object") throw Error();
    expect(op.body.multiagent.agents).toHaveLength(4);
    expect(op.body.multiagent.agents.every(a => "version" in a && a.version === 3)).toBe(true);
    delete o.receipts!.agents!.prospector; expect(() => buildCompanyProvisionPlan(o)).toThrow();
    const duplicate = withAgents(); duplicate.stage = "coordinator"; duplicate.receipts!.agents!.prospector!.id = duplicate.receipts!.agents!.outreach!.id; expect(() => buildCompanyProvisionPlan(duplicate)).toThrow();
  });
  it("creates credentials only with complete exact agent/vault receipts and separate private file references", () => {
    const o = withAgents(); o.stage = "credentials";
    const ops = buildCompanyProvisionPlan(o).operations; expect(ops).toHaveLength(7);
    for (const op of ops) { if (op.kind !== "credential") throw Error(); expect(op.body).not.toHaveProperty("value"); expect(op.body.agent_id).toMatch(/^agt_/); expect(op.valueFile).toMatch(/^\/private\//); }
    o.credentialFiles!.planner = o.credentialFiles!.prospector; expect(() => buildCompanyProvisionPlan(o)).toThrow();
    const mismatch = withAgents(); mismatch.stage = "credentials"; mismatch.receipts!.vaults!.planner!.name = "other"; expect(() => buildCompanyProvisionPlan(mismatch)).toThrow();
  });
  it("keeps all five deployments disabled with bounded budgets and exact identity", () => {
    const o = withAgents(); o.stage = "deployments";
    const ops = buildCompanyProvisionPlan(o).operations; expect(ops).toHaveLength(5);
    for (const op of ops) { if (op.kind !== "deployment") throw Error(); expect(op.body.enabled).toBe(false); expect(op.body.agent_version).toBeGreaterThan(0); expect(op.body.budget_micro_usd).toBeGreaterThan(0); }
    o.schedules!.planner!.budgetMicroUsd = 0; expect(() => buildCompanyProvisionPlan(o)).toThrow();
    o.schedules!.planner!.budgetMicroUsd = 99_000_000; expect(() => buildCompanyProvisionPlan(o)).toThrow();
  });
  it("rejects missing schedules, unknown timezone, unsafe callback and credential aliasing", () => {
    const o = withAgents(); o.stage = "deployments"; delete o.schedules!.outreach; expect(() => buildCompanyProvisionPlan(o)).toThrow();
    const zone = withAgents(); zone.stage = "deployments"; zone.schedules!.planner!.timezone = "bad/zone"; expect(() => buildCompanyProvisionPlan(zone)).toThrow();
    const callback = withAgents(); callback.stage = "deployments"; callback.schedules!.planner!.onIdleUrl = "https://secret@example.com/idle"; expect(() => buildCompanyProvisionPlan(callback)).toThrow();
    const alias = withAgents(); alias.stage = "deployments"; alias.receipts!.credentials!.planner!.id = alias.receipts!.credentials!.prospector!.id; expect(() => buildCompanyProvisionPlan(alias)).toThrow();
  });
  it("detaches generated bodies from input receipts and catalog resources", () => {
    const o = withAgents(); o.stage = "agents"; const first = buildCompanyProvisionPlan(o); const op = first.operations[0]!; if (op.kind !== "agent") throw Error();
    op.body.system = "changed"; expect(JSON.stringify(buildCompanyProvisionPlan(o))).not.toContain('"system":"changed"');
  });
});

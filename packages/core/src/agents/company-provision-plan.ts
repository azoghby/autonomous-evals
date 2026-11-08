/** Offline staged plans. Receipts are operator-retained inputs, not fresh provider attestation. */
import type { AgentCreate, CredentialCreate, DeploymentCreate, OutcomeCreate, VaultCreate } from "@usenaive-sdk/managed-agents";
import { COMPANY_SKILLS, COMPANY_OUTCOMES, type CompanySkill } from "./company-resources";
import { buildCompanyAgentCreateBody, COMPANY_COORDINATOR_ROLES, COMPANY_ROLE_DEFINITIONS, type CompanyRole, type CompanyAgentOptions } from "./company-roles";
import { configFingerprint, type ProvisionReceipt } from "./naive-provisioning";
import type { ExpectedAgentConfiguration } from "./provision";

export type CompanyProvisionStage = "resources" | "agents" | "coordinator" | "credentials" | "deployments";
export interface CompanyAgentReceipt extends ProvisionReceipt { version: number; name: string; configurationFingerprint: string }
export interface CompanyProvisionReceipts {
  /** SDK resolved-reference schema supports slug@N; provider resolution still needs attestation. */
  skills?: Record<string, { id: string; version: number; reference: string; sha256: string }>;
  outcomes?: Record<string, { id: string }>;
  vaults?: Partial<Record<CompanyRole, { id: string; name: string }>>;
  agents?: Partial<Record<CompanyRole, CompanyAgentReceipt>>;
  credentials?: Partial<Record<CompanyRole, { id: string; agentId: string; vaultId: string; mcpUrl: string }>>;
}
export interface CompanyProvisionPlanOptions {
  stage: CompanyProvisionStage;
  /** Explicit opt-in to NEW names; this never updates the existing legacy agents. */
  createRevisionAgents: true;
  revision: string;
  model?: string;
  internalMcpUrl?: string;
  receipts?: CompanyProvisionReceipts;
  credentialFiles?: Partial<Record<CompanyRole, string>>;
  schedules?: Partial<Record<CompanyRole, { cron: string; timezone: string; inputTemplate: string; onIdleUrl: string; budgetMicroUsd?: number }>>;
}
export type CompanyProvisionPlanOperation =
  | { kind: "skill"; body: CompanySkill }
  | { kind: "outcome"; body: OutcomeCreate }
  | { kind: "vault"; body: VaultCreate }
  | { kind: "agent"; body: AgentCreate & ExpectedAgentConfiguration; pin?: ProvisionReceipt }
  | { kind: "credential"; body: Omit<CredentialCreate, "value">; vaultId: string; valueFile: string }
  | { kind: "deployment"; name: string; body: DeploymentCreate };
export interface CompanyProvisionPlan { stage: CompanyProvisionStage; operations: CompanyProvisionPlanOperation[] }
const roles = Object.keys(COMPANY_ROLE_DEFINITIONS) as CompanyRole[];
const mcpRoles = roles.filter(role => Object.keys(COMPANY_ROLE_DEFINITIONS[role].tools).some(tool => tool.startsWith("se_internal.")));
const fail = (): never => { throw new Error("Company provisioning dependencies invalid or incomplete"); };
const id = (value: unknown, prefix: string): value is string => typeof value === "string" && new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`).test(value);
const version = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const clean = (value: unknown): value is string => typeof value === "string" && !!value.trim() && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
function https(value: unknown): string {
  if (!clean(value)) return fail();
  try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname.includes(".")) return fail(); return url.href; } catch { return fail(); }
}
/** All stage outputs are detached. Missing dependencies yield no partial plan. No I/O. */
export function buildCompanyProvisionPlan(input: CompanyProvisionPlanOptions): CompanyProvisionPlan {
  const options = structuredClone(input);
  if (!options || options.createRevisionAgents !== true || typeof options.revision !== "string" || !/^[a-z][a-z0-9-]{0,19}$/.test(options.revision) ||
    !["resources", "agents", "coordinator", "credentials", "deployments"].includes(options.stage)) return fail();
  const receipts = options.receipts ?? {};
  const agentName = (role: CompanyRole) => `${COMPANY_ROLE_DEFINITIONS[role].agentName}-${options.revision}`;
  const vaultName = (role: CompanyRole) => `se-${role.replaceAll("_", "-")}-${options.revision}`;
  if (options.stage === "resources") return { stage: options.stage, operations: [
    ...COMPANY_SKILLS.map(body => ({ kind: "skill" as const, body: structuredClone(body) })),
    ...COMPANY_OUTCOMES.map(body => ({ kind: "outcome" as const, body: structuredClone(body) })),
    ...mcpRoles.map(role => ({ kind: "vault" as const, body: { display_name: vaultName(role), identity_id: null } })),
  ] };
  const skillIds: Record<string, string> = {};
  const skillReceipts = new Set<string>();
  for (const skill of COMPANY_SKILLS) {
    const r = receipts.skills?.[skill.slug];
    if (!r || !id(r.id, "skl") || !version(r.version) || r.reference !== `${skill.slug}@${r.version}` || r.sha256 !== skill.sha256 || skillReceipts.has(r.id)) return fail();
    skillReceipts.add(r.id);
    skillIds[skill.slug] = r.reference;
  }
  for (const outcome of COMPANY_OUTCOMES) if (!id(receipts.outcomes?.[outcome.name]?.id, "ocm")) return fail();
  const internalMcpUrl = https(options.internalMcpUrl);
  const baseOptions: CompanyAgentOptions = { skillIds, internalMcpUrl, model: options.model };
  const desired = (role: CompanyRole): AgentCreate & ExpectedAgentConfiguration => {
    const config = buildCompanyAgentCreateBody(role, baseOptions);
    return { ...config, name: agentName(role), metadata: { ...config.metadata, ae_provision_revision: options.revision } };
  };
  const seen = new Set<string>();
  function agentReceipt(role: CompanyRole): CompanyAgentReceipt {
    const r = receipts.agents?.[role];
    if (!r || !id(r.id, "agt") || !version(r.version) || r.name !== agentName(role) || r.configurationFingerprint !== configFingerprint(desired(role))) return fail();
    return r;
  }
  // Every supplied role pin must match this exact desired configuration, never an old name.
  for (const role of roles.filter(role => role !== "planner")) {
    if (!receipts.agents?.[role]) continue;
    const r = agentReceipt(role); if (seen.has(r.id)) return fail(); seen.add(r.id);
  }
  if (options.stage === "agents") return { stage: options.stage, operations: roles.filter(role => role !== "planner").map(role => {
    const r = receipts.agents?.[role]; return { kind: "agent", body: desired(role), ...(r ? { pin: { id: r.id, version: r.version } } : {}) };
  }) };
  baseOptions.coordinatorAgents = Object.fromEntries(COMPANY_COORDINATOR_ROLES.map(role => {
    const r = agentReceipt(role); return [role, { agentId: r.id, agentVersion: r.version }];
  })) as CompanyAgentOptions["coordinatorAgents"];
  if (options.stage === "coordinator") {
    const r = receipts.agents?.planner ? agentReceipt("planner") : undefined;
    if (r && seen.has(r.id)) return fail();
    return { stage: options.stage, operations: [{ kind: "agent", body: desired("planner"), ...(r ? { pin: { id: r.id, version: r.version } } : {}) }] };
  }
  for (const role of roles) agentReceipt(role);
  const planner = agentReceipt("planner"); if (seen.has(planner.id)) return fail();
  const vaults = new Set<string>();
  for (const role of mcpRoles) { const r = receipts.vaults?.[role]; if (!r || !id(r.id, "vlt") || r.name !== vaultName(role) || vaults.has(r.id)) return fail(); vaults.add(r.id); }
  if (options.stage === "credentials") {
    const paths = new Set<string>();
    const operations: CompanyProvisionPlanOperation[] = mcpRoles.map(role => {
      const path = options.credentialFiles?.[role]; if (!clean(path) || !path.startsWith("/") || paths.has(path)) return fail(); paths.add(path);
      return { kind: "credential", vaultId: receipts.vaults![role]!.id, valueFile: path,
        body: { key: `${vaultName(role)}-mcp`, kind: "static_bearer", agent_id: agentReceipt(role).id, mcp_server_url: internalMcpUrl } };
    });
    return { stage: options.stage, operations };
  }
  const credentialIds = new Set<string>();
  for (const role of mcpRoles) {
    const r = receipts.credentials?.[role];
    if (!r || !id(r.id, "vcr") || r.agentId !== agentReceipt(role).id || r.vaultId !== receipts.vaults![role]!.id || r.mcpUrl !== internalMcpUrl || credentialIds.has(r.id)) return fail(); credentialIds.add(r.id);
  }
  return { stage: options.stage, operations: roles.filter(role => COMPANY_ROLE_DEFINITIONS[role].deployment).map(role => {
    const d = COMPANY_ROLE_DEFINITIONS[role], s = options.schedules?.[role], r = agentReceipt(role);
    if (!s || !clean(s.cron) || s.cron.split(/\s+/).length !== 5 || !clean(s.timezone) || !clean(s.inputTemplate)) return fail();
    try { new Intl.DateTimeFormat("en", { timeZone: s.timezone }); } catch { return fail(); }
    const budget = s.budgetMicroUsd ?? d.maxTaskMicroUsd;
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > d.maxTaskMicroUsd) return fail();
    return { kind: "deployment", name: agentName(role), body: { agent_id: r.id, agent_version: r.version, cron: s.cron, timezone: s.timezone,
      input_template: s.inputTemplate, budget_micro_usd: budget, window: "immediate", identity: null, on_idle: https(s.onIdleUrl), enabled: false } };
  }) };
}

/** Operator-only provisioning. Existing agents are never edited or deleted. */
import type { AgentCreate, VettaClient } from "@usenaive-sdk/managed-agents";
import type { AgentDirectory, AgentRole } from "../evals/types";
import { DEFAULT_AGENT_MODEL, ROLE_DEFINITIONS } from "./roles";

export function buildAgentCreateBody(role: AgentRole, model: string = DEFAULT_AGENT_MODEL): AgentCreate {
  const def = ROLE_DEFINITIONS[role];
  return {
    name: def.agentName,
    model,
    window: "immediate",
    model_selection: null,
    system: def.system,
    description: def.description,
    budget: { cap_micro_usd: def.periodCapMicroUsd, max_task_micro_usd: def.maxTaskMicroUsd, period: "month" },
    // No built-in tools at all: the agents read the task and return JSON.
    tools: { default_config: { permission: "deny" }, configs: {} },
    mcp_servers: [],
    skills: [],
    multiagent: false,
    handoffs: false,
    metadata: { ae_role: role, ae_managed: true },
  };
}

export type ProvisionDiagnosticCode =
  | "invalid_options" | "inspection_failed" | "incomplete_listing" | "duplicate_role"
  | "identity_mismatch" | "configuration_mismatch" | "attestation_unavailable" | "creation_uncertain";

export interface ProvisionDiagnostic {
  code: ProvisionDiagnosticCode;
  phase: "discovery" | "existing" | "creation";
  role?: AgentRole;
  /** Field paths only: never raw provider configuration, instructions, headers or errors. */
  fields?: string[];
}

/** No usable directory is returned on failure. Creation may already have occurred; reconcile before retry. */
export class AgentProvisioningError extends Error {
  readonly operatorNeeded = true;
  constructor(readonly diagnostic: ProvisionDiagnostic, readonly created: Partial<AgentDirectory> = {}) {
    super(`Agent provisioning needs operator: ${diagnostic.code} (${diagnostic.phase})`);
    this.name = "AgentProvisioningError";
  }
}

export interface ProvisionOptions {
  model?: string;
  dryRun?: boolean;
  /** Verify these exact IDs/versions, never silently advance a configured pin. */
  directory?: Partial<AgentDirectory>;
}

type Config = Awaited<ReturnType<VettaClient["agents"]["getVersion"]>>;
const roles = Object.keys(ROLE_DEFINITIONS) as AgentRole[];
const positiveVersion = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function checkConfig(config: Omit<Config, "version" | "created_by" | "created_at">, role: AgentRole, model: string, phase: "existing" | "creation") {
  const expected = buildAgentCreateBody(role, model);
  const missing: string[] = [];
  const changed: string[] = [];
  const check = (field: string, actual: unknown, wanted: unknown) => {
    if (actual === undefined) missing.push(field);
    else if (actual !== wanted) changed.push(field);
  };
  check("metadata.ae_role", config.metadata?.ae_role, role);
  check("metadata.ae_managed", config.metadata?.ae_managed, true);
  check("model", config.model, model);
  // Null/absent means no dynamic selection in SDK 0.12.3. A policy overrides the fixed model.
  if (config.model_selection != null) changed.push("model_selection");
  check("window", config.window, expected.window);
  check("system", config.system, expected.system);
  check("description", config.description, expected.description);
  check("tools.default_config.permission", config.tools?.default_config?.permission, "deny");
  if (!config.tools?.configs) missing.push("tools.configs");
  else if (Object.keys(config.tools.configs).length) changed.push("tools.configs");
  for (const field of ["mcp_servers", "skills"] as const) {
    if (!Array.isArray(config[field])) missing.push(field);
    else if (config[field].length) changed.push(field);
  }
  check("multiagent", config.multiagent, false);
  // Unlike model_selection, absence does NOT attest disabled handoffs on older versions.
  check("handoffs", config.handoffs, false);
  for (const field of ["cap_micro_usd", "max_task_micro_usd", "period"] as const) {
    check(`budget.${field}`, config.budget?.[field], expected.budget[field]);
  }
  if (missing.length || changed.length) throw new AgentProvisioningError({
    code: missing.length ? "attestation_unavailable" : "configuration_mismatch",
    phase, role, fields: [...missing, ...changed],
  });
}

export async function ensureAgents(
  client: Pick<VettaClient, "agents">,
  options: ProvisionOptions = {},
): Promise<{ directory: Partial<AgentDirectory>; created: AgentRole[]; missing: AgentRole[] }> {
  const model = options.model ?? DEFAULT_AGENT_MODEL;
  if (!model.trim() || (options.directory && Object.entries(options.directory).some(([role, pin]) =>
    !roles.includes(role as AgentRole) || !pin || !/^agt_[0-9a-hjkmnp-tv-z]{26}$/.test(pin.agentId) || !positiveVersion(pin.agentVersion)))) {
    throw new AgentProvisioningError({ code: "invalid_options", phase: "discovery" });
  }
  const createdDirectory: Partial<AgentDirectory> = {};
  let phase: ProvisionDiagnostic["phase"] = "discovery";
  let activeRole: AgentRole | undefined;
  try {
    const byName = new Map<string, Array<{ id: string; current_version: number }>>();
    const seenIds = new Set<string>();
    const cursors = new Set<string>();
    let after: string | undefined;
    let complete = false;
    for (let page = 0; page < 20; page++) {
      const res = await client.agents.list({ limit: 100, after });
      if (res.data.length > 100 || typeof res.has_more !== "boolean" ||
          (res.has_more ? !res.next_cursor : res.next_cursor !== null)) {
        throw new AgentProvisioningError({ code: "incomplete_listing", phase });
      }
      for (const a of res.data) {
        if (seenIds.has(a.id)) throw new AgentProvisioningError({ code: "incomplete_listing", phase });
        seenIds.add(a.id);
        const entries = byName.get(a.name) ?? [];
        entries.push({ id: a.id, current_version: a.current_version });
        byName.set(a.name, entries);
      }
      if (!res.has_more) { complete = true; break; }
      if (cursors.has(res.next_cursor!)) throw new AgentProvisioningError({ code: "incomplete_listing", phase });
      cursors.add(res.next_cursor!);
      after = res.next_cursor!;
    }
    if (!complete) throw new AgentProvisioningError({ code: "incomplete_listing", phase });
    // Resolve all ambiguity before any cloud mutation.
    for (const role of roles) {
      const matches = byName.get(ROLE_DEFINITIONS[role].agentName) ?? [];
      if (matches.length > 1) throw new AgentProvisioningError({ code: "duplicate_role", phase, role });
      const pin = options.directory?.[role];
      if (pin && (matches.length !== 1 || matches[0]!.id !== pin.agentId)) {
        throw new AgentProvisioningError({ code: "identity_mismatch", phase, role });
      }
    }
    const directory: Partial<AgentDirectory> = {};
    const missing: AgentRole[] = [];
    phase = "existing";
    for (const role of roles) {
      activeRole = role;
      const found = byName.get(ROLE_DEFINITIONS[role].agentName)?.[0];
      if (!found) { missing.push(role); continue; }
      const current = await client.agents.get(found.id);
      if (current.id !== found.id || current.name !== ROLE_DEFINITIONS[role].agentName) {
        throw new AgentProvisioningError({ code: "identity_mismatch", phase, role });
      }
      const version = options.directory?.[role]?.agentVersion ?? found.current_version;
      if (!positiveVersion(version)) throw new AgentProvisioningError({ code: "attestation_unavailable", phase, role, fields: ["version"] });
      const config = await client.agents.getVersion(found.id, version);
      if (config.version !== version) throw new AgentProvisioningError({ code: "identity_mismatch", phase, role, fields: ["version"] });
      checkConfig(config, role, model, phase);
      directory[role] = { agentId: found.id, agentVersion: version };
    }
    if (options.dryRun) return { directory, created: [], missing };
    const created: AgentRole[] = [];
    phase = "creation";
    for (const role of missing) {
      activeRole = role;
      const agent = await client.agents.create(buildAgentCreateBody(role, model));
      // Retain returned identity for manual reconciliation even when response config is rejected.
      createdDirectory[role] = { agentId: agent.id, agentVersion: agent.current_version };
      if (agent.name !== ROLE_DEFINITIONS[role].agentName || !positiveVersion(agent.current_version)) {
        throw new AgentProvisioningError({ code: "identity_mismatch", phase, role });
      }
      checkConfig(agent, role, model, phase);
      const config = await client.agents.getVersion(agent.id, agent.current_version);
      if (config.version !== agent.current_version) throw new AgentProvisioningError({ code: "identity_mismatch", phase, role, fields: ["version"] });
      checkConfig(config, role, model, phase);
      directory[role] = createdDirectory[role];
      created.push(role);
    }
    return { directory, created, missing: [] };
  } catch (error) {
    if (error instanceof AgentProvisioningError) throw new AgentProvisioningError(error.diagnostic, createdDirectory);
    // Do not leak provider bodies, URLs, credentials or configuration through an error cause.
    throw new AgentProvisioningError({ code: phase === "creation" ? "creation_uncertain" : "inspection_failed", phase, role: activeRole }, createdDirectory);
  }
}

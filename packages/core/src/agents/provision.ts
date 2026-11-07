/**
 * One-time agent provisioning (operator script, not a workflow step).
 * Finds each role's agent by name and creates only the missing ones, with server-side budget caps
 * equal to the role caps, all tools denied, and no handoffs.
 */
import type { AgentCreate, VettaClient } from "@usenaive-sdk/managed-agents";
import type { AgentDirectory, AgentRole } from "../evals/types";
import { DEFAULT_AGENT_MODEL, ROLE_DEFINITIONS } from "./roles";

export function buildAgentCreateBody(role: AgentRole, model: string = DEFAULT_AGENT_MODEL): AgentCreate {
  const def = ROLE_DEFINITIONS[role];
  return {
    name: def.agentName,
    model,
    window: "immediate",
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

export async function ensureAgents(
  client: Pick<VettaClient, "agents">,
  options: { model?: string; dryRun?: boolean } = {},
): Promise<{ directory: Partial<AgentDirectory>; created: AgentRole[]; missing: AgentRole[] }> {
  const byName = new Map<string, { id: string; current_version: number }>();
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await client.agents.list({ limit: 100, after });
    for (const a of res.data) byName.set(a.name, { id: a.id, current_version: a.current_version });
    if (!res.next_cursor) break;
    after = res.next_cursor;
  }
  const directory: Partial<AgentDirectory> = {};
  const created: AgentRole[] = [];
  const missing: AgentRole[] = [];
  for (const role of Object.keys(ROLE_DEFINITIONS) as AgentRole[]) {
    const found = byName.get(ROLE_DEFINITIONS[role].agentName);
    if (found) {
      directory[role] = { agentId: found.id, agentVersion: found.current_version };
      continue;
    }
    if (options.dryRun) {
      missing.push(role);
      continue;
    }
    const agent = await client.agents.create(buildAgentCreateBody(role, options.model));
    directory[role] = { agentId: agent.id, agentVersion: agent.current_version };
    created.push(role);
  }
  return { directory, created, missing };
}

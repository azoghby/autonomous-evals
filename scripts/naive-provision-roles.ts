/**
 * Idempotent Naïve agent provisioning for the four Track B eval roles used by EVAL_SERVICES=real (operator-only).
 * (`scripts/naive-provision.ts` is Track B's staged, journaled provisioner for the company-role manifest.)
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/naive-provision-roles.ts                    # dry run (default): list + verify, create nothing
 *   npx tsx --env-file=.env scripts/naive-provision-roles.ts --apply            # create missing roles, verify existing ones
 *   ... --apply --write-env /abs/path/.env                                 # also upsert NAIVE_AGENT_* = <id>@<version>
 *   ... --prefix standard-evals-  --model zai-org/GLM-5.2-FP8              # defaults shown
 *
 * Safety (see docs/NAIVE_PLAN.md §7):
 *   - Delegates to `ensureAgents` (packages/core/src/agents/provision.ts): existing agents are never edited or
 *     deleted; every role is attested as tools-denied, no MCP, no skills, `multiagent:false`, `handoffs:false`.
 *     Handoffs stay OFF because every non-false policy can reach the org's existing CEO agent.
 *   - Agents are namespaced (`standard-evals-<role>`); unrelated agents in the org (e.g. "CEO") are ignored.
 *   - Per-task (session) caps come from ROLE_DEFINITIONS and must be >= $0.25 (Naïve pre-flight refused $0.10).
 *   - Prints names, IDs and versions only. Never prints the API key or provider error bodies.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { AgentDirectory, AgentRole } from "../packages/core/src/evals/types";
import { DEFAULT_AGENT_MODEL, ROLE_DEFINITIONS } from "../packages/core/src/agents/roles";

// The SDK is ESM-only (no "require" export); load SDK-importing modules through the ESM loader.
const loadProvision = () => import("../packages/core/src/agents/provision");
const loadAdapter = () => import("../packages/core/src/agents/naive-adapter");

/** Mirrors NAIVE_AGENT_ENV in packages/core/src/integration/eval-services.ts (kept import-free here). */
const NAIVE_AGENT_ENV: Readonly<Record<AgentRole, string>> = {
  commercial: "NAIVE_AGENT_COMMERCIAL",
  evaluation_engineer: "NAIVE_AGENT_EVALUATION_ENGINEER",
  quality_investigator: "NAIVE_AGENT_QUALITY_INVESTIGATOR",
  company_operator: "NAIVE_AGENT_COMPANY_OPERATOR",
};

const MIN_SESSION_BUDGET_MICRO_USD = 250_000;
const DEFAULT_PREFIX = "standard-evals-";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Pure: replace or append `NAME=value` lines. Other lines (and their order) are preserved. */
export function upsertEnvLines(source: string, values: Record<string, string>): string {
  const lines = source.length ? source.replace(/\n$/, "").split("\n") : [];
  const pending = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const name = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (!name || !pending.has(name)) return line;
    const next = `${name}=${pending.get(name)}`;
    pending.delete(name);
    return next;
  });
  for (const [name, value] of pending) out.push(`${name}=${value}`);
  return `${out.join("\n")}\n`;
}

function assertSessionBudgets(): void {
  for (const [role, def] of Object.entries(ROLE_DEFINITIONS)) {
    if (def.maxTaskMicroUsd < MIN_SESSION_BUDGET_MICRO_USD) {
      throw new Error(`${role}: max_task_micro_usd ${def.maxTaskMicroUsd} is below the $0.25 Naïve pre-flight floor`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const prefix = flag(args, "--prefix") ?? DEFAULT_PREFIX;
  const model = flag(args, "--model") ?? DEFAULT_AGENT_MODEL;
  const envPath = flag(args, "--write-env");
  const apiKey = process.env.NAIVE_API_KEY?.trim();
  if (!apiKey) throw new Error("NAIVE_API_KEY is not set");
  if (envPath && !apply) throw new Error("--write-env requires --apply");
  assertSessionBudgets();

  const { createNaiveClient } = await loadAdapter();
  const { agentNameFor, ensureAgents } = await loadProvision();
  const client = createNaiveClient({ apiKey, baseUrl: process.env.NAIVE_BASE_URL || undefined });
  console.log(`mode=${apply ? "apply" : "dry-run"} prefix=${prefix} model=${model}`);
  const result = await ensureAgents(client, { model, namePrefix: prefix, dryRun: !apply });

  const roles = Object.keys(ROLE_DEFINITIONS) as AgentRole[];
  for (const role of roles) {
    const pin = result.directory[role];
    const state = result.created.includes(role) ? "created" : pin ? "verified" : "missing (dry run: would create)";
    console.log(`${role.padEnd(21)} ${agentNameFor(role, prefix).padEnd(36)} ${pin ? `${pin.agentId}@${pin.agentVersion}` : "-"}  ${state}`);
  }

  if (envPath) {
    const directory = result.directory as AgentDirectory;
    const values = Object.fromEntries(roles.map((role) => {
      const pin = directory[role];
      if (!pin) throw new Error(`no pin for ${role}; refusing to write a partial env`);
      return [NAIVE_AGENT_ENV[role], `${pin.agentId}@${pin.agentVersion}`];
    }));
    writeFileSync(envPath, upsertEnvLines(readFileSync(envPath, "utf8"), values));
    console.log(`wrote ${Object.keys(values).join(", ")} to ${envPath} (values not printed)`);
  }
}

if (process.argv[1]?.endsWith("naive-provision-roles.ts")) {
  main().catch(async (error: unknown) => {
    const { AgentProvisioningError } = await loadProvision();
    if (error instanceof AgentProvisioningError) {
      console.error(`provisioning needs operator: ${JSON.stringify(error.diagnostic)}`);
      const created = Object.entries(error.created).map(([r, p]) => `${r}=${p?.agentId}@${p?.agentVersion}`);
      if (created.length) console.error(`created before failure (reconcile manually): ${created.join(" ")}`);
    } else {
      console.error(error instanceof Error ? error.message : "provisioning failed");
    }
    process.exit(1);
  });
}

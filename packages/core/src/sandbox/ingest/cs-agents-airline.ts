import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnvironmentSpec } from "./build";
import type { SqlExec } from "./types";

/**
 * OpenAI's open-source airline customer-service agents (openai/openai-cs-agents-demo, MIT) as a sandbox env:
 * the 10 tools its agents use, same names and args, bound to SQL over the demo's mock itineraries.
 * See data/envs/cs-agents-airline/NOTICE.md. packages/core/src/sandbox/ingest -> repo root is five levels up.
 */
const ENV_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../data/envs/cs-agents-airline");
const read = (f: string): string => readFileSync(resolve(ENV_DIR, f), "utf8");

/** demo_data.py itineraries are dated 2024-12-09; the clock sits on the day of the disruption. */
export const CS_AIRLINE_FROZEN_NOW = "2024-12-09T12:00:00Z";

export async function buildCsAgentsAirline(exec?: SqlExec) {
  return buildEnvironmentSpec({
    id: "cs_agents_airline",
    name: "OpenAI CS Agents Demo - Airline",
    domain: "airline customer service: seat changes, flight status, rebooking, cancellation, delay compensation",
    openapi: read("openapi.yaml"),
    ddl: read("schema.sql"),
    seedSql: read("seed.sql"),
    frozenNow: CS_AIRLINE_FROZEN_NOW,
    policiesMarkdown: read("policies.md"),
    workflows: JSON.parse(read("workflows.json")) as unknown[],
    exec,
  });
}

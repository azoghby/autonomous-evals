import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnvironmentSpec } from "./build";
import type { SqlExec } from "./types";

/**
 * Google ADK "customer-service" sample (Cymbal Home & Garden, Apache-2.0) as a sandbox env.
 * See data/envs/adk-customer-service/NOTICE.md. packages/core/src/sandbox/ingest -> repo root is five levels up.
 */
const ENV_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../data/envs/adk-customer-service");
const read = (f: string): string => readFileSync(resolve(ENV_DIR, f), "utf8");

/**
 * Dry-run args for tools whose params are arrays/objects. The ingest dry-run binds raw values while the runtime
 * JSON-encodes arrays/objects (convertParamValue), so these are JSON text; the SQL reads them with CAST(:p AS jsonb).
 */
const EXAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  modify_cart: { customer_id: "123", items_to_add: '[{"product_id":"soil-456","quantity":1}]', items_to_remove: '["soil-123"]' },
  update_salesforce_crm: { customer_id: "123", details: '{"services":"Planting","appointment_date":"2024-07-29"}' },
};

export async function buildAdkCustomerService(exec?: SqlExec) {
  return buildEnvironmentSpec({
    id: "adk_customer_service",
    name: "ADK Customer Service (Cymbal Home & Garden)",
    domain: "home & garden retail: cart, product recommendations, discounts, planting appointments",
    openapi: read("openapi.yaml"),
    ddl: read("schema.sql"),
    seedSql: read("seed.sql"),
    frozenNow: "2024-07-22T16:00:00Z",
    policiesMarkdown: read("policies.md"),
    workflows: JSON.parse(read("workflows.json")) as unknown[],
    exampleArgs: EXAMPLE_ARGS,
    exec,
  });
}

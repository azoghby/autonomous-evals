import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnvironmentSpec } from "./build";
import type { SqlExec } from "./types";

/**
 * tau2-bench retail domain (MIT, Sierra Research) as a sandbox env. See data/envs/tau2-retail/NOTICE.md.
 * packages/core/src/sandbox/ingest -> repo root is five levels up.
 */
const ENV_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../data/envs/tau2-retail");
const read = (f: string): string => readFileSync(resolve(ENV_DIR, f), "utf8");

/**
 * Dry-run args for write tools. Array params are JSON text because the ingest dry-run binds raw values,
 * while the runtime JSON-encodes arrays (convertParamValue); the SQL reads them with CAST(:p AS jsonb).
 */
const EXAMPLE_ARGS: Record<string, Record<string, unknown>> = {
  modify_pending_order_items: { item_ids: '["1008292230"]', new_item_ids: '["1008292231"]' },
  exchange_delivered_order_items: { item_ids: '["1008292230"]', new_item_ids: '["1008292231"]' },
  return_delivered_order_items: { item_ids: '["1008292230"]' },
};

export async function buildTau2Retail(exec?: SqlExec) {
  return buildEnvironmentSpec({
    id: "tau2_retail",
    name: "tau2-bench Retail",
    domain: "retail customer service: orders, returns, exchanges, address and payment changes",
    openapi: read("openapi.yaml"),
    ddl: read("schema.sql"),
    seedSql: read("seed.sql"),
    frozenNow: "2025-01-01T12:00:00Z",
    policiesMarkdown: read("policies.md"),
    workflows: JSON.parse(read("workflows.json")) as unknown[],
    exampleArgs: EXAMPLE_ARGS,
    exec,
  });
}

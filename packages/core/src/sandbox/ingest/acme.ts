import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnvironmentSpec } from "./build";
import type { SqlExec } from "./types";

/** packages/core/src/sandbox/ingest -> repo root is five levels up. */
const ENV_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../data/envs/acme-support");
const read = (f: string): string => readFileSync(resolve(ENV_DIR, f), "utf8");

export async function buildAcmeSupport(exec?: SqlExec) {
  return buildEnvironmentSpec({
    id: "acme_support",
    name: "Acme Support",
    domain: "customer support: orders, refunds, tickets",
    openapi: read("openapi.yaml"),
    ddl: read("schema.sql"),
    seedSql: read("seed.sql"),
    frozenNow: "2026-06-01T15:00:00Z",
    policiesMarkdown: read("policies.md"),
    workflows: JSON.parse(read("workflows.json")) as unknown[],
    exec,
  });
}

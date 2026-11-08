import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { EnvironmentSpec } from "../spec";
import { buildAcmeSupport } from "./acme";
import { buildEnvironmentSpec, tablesFromDdl } from "./build";
import { createPgliteExec } from "./validate";

const openapi = {
  openapi: "3.0.0", info: { title: "t", version: "1" },
  paths: { "/items/{id}": { get: { operationId: "get_item", summary: "Get item", parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", example: 1 } }],
    "x-sandbox-sql": { statements: ["SELECT * FROM items WHERE id = :id"], resultShape: "row" }, responses: { "200": { description: "ok" } } } } },
};
const workflows = [{ id: "lookup", name: "Lookup", description: "d", tools: ["get_item"] }];
const ddl = "CREATE TABLE items (id int primary key, name text);";
const seedSql = "INSERT INTO items VALUES (1, 'a');";

describe("buildEnvironmentSpec", () => {
  it("builds a valid spec from inline inputs", async () => {
    const { spec, report } = await buildEnvironmentSpec({ id: "mini", name: "Mini", domain: "d", openapi, ddl, seedSql, workflows, exec: createPgliteExec(new PGlite()) });
    expect(EnvironmentSpec.safeParse(spec).success).toBe(true);
    expect(spec.tools.map((t) => t.name)).toEqual(["get_item"]);
    expect(spec.tools[0]!.binding.kind).toBe("sql");
    expect(spec.state.reportTables).toEqual(["items"]);
    expect(spec.integration.mode).toBe("tool_loop");
    expect(report.validation?.ok).toBe(true);
  });

  it("errors on duplicate tool names across sources", async () => {
    const functions = [{ name: "get_item", description: "dup", parameters: { type: "object", properties: {} } }];
    await expect(buildEnvironmentSpec({ id: "mini", name: "Mini", domain: "d", openapi, functions, ddl, seedSql, workflows })).rejects.toThrow(/Duplicate/);
  });

  it("extracts tables from DDL excluding sandbox_*", () => {
    expect(tablesFromDdl(ddl)).toEqual(["items"]);
  });
});

const envDir = resolve(fileURLToPath(import.meta.url), "../../../../../../data/envs/acme-support");
const haveAcme = ["openapi.yaml", "schema.sql", "seed.sql", "policies.md", "workflows.json"].every((f) => existsSync(resolve(envDir, f)));

describe.skipIf(!haveAcme)("buildAcmeSupport", () => {
  it("builds 9 tools with no downgrades", async () => {
    const { spec, report } = await buildAcmeSupport(createPgliteExec(new PGlite()));
    expect(spec.tools).toHaveLength(9);
    const by = Object.fromEntries(spec.tools.map((t) => [t.name, t.binding.kind]));
    expect(by.get_order).toBe("sql");
    expect(by.create_refund).toBe("sql");
    expect(by.send_email).toBe("simulated");
    expect(report.validation?.downgraded.map((t) => t.name) ?? []).toEqual([]);
  }, 60_000);
});

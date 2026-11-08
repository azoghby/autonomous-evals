import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { ToolSpec } from "../spec";
import type { SqlExec } from "./types";
import { createPgliteExec, validateWorld } from "./validate";

const sqlTool = (name: string, statements: string[], effect: ToolSpec["effect"] = "read", extra: Partial<ToolSpec> = {}): ToolSpec => ({
  name, description: `${name} tool`, effect, source: "test",
  inputSchema: { type: "object", properties: { id: { type: "integer", example: 1 } }, required: ["id"] },
  binding: { kind: "sql", statements, resultShape: "rows" }, ...extra,
});

function fakeExec(failOn?: string, failDdl = false) {
  const calls: string[] = [];
  const exec: SqlExec = {
    async exec(sql) { calls.push(`exec:${sql.trim().split(/\s+/)[0]}`); if (failDdl && /create/i.test(sql)) throw new Error("ddl boom"); },
    async query(sql, params) { calls.push(`query:${sql}`); if (failOn && sql.includes(failOn)) throw new Error("bad column"); return [{ id: params?.[0] }]; },
  };
  return { exec, calls };
}
const DDL = "CREATE TABLE t (id int);";

describe("validateWorld (fake exec)", () => {
  it("downgrades a failing sql tool to simulated with a warning and always rolls back", async () => {
    const { exec, calls } = fakeExec("broken");
    const tools = [sqlTool("good", ["SELECT * FROM t WHERE id = :id"]), sqlTool("bad", ["SELECT broken FROM t WHERE id = :id"], "write")];
    const r = await validateWorld(exec, { ddl: DDL, seedSql: "INSERT INTO t VALUES (1);", tools });
    expect(r.ok).toBe(true);
    expect(r.tools.good!.status).toBe("ok");
    expect(r.tools.bad!.status).toBe("downgraded");
    expect(r.tools.bad!.warnings.join(" ")).toContain("bad column");
    expect(r.downgraded).toHaveLength(1);
    expect(r.downgraded[0]!.binding).toMatchObject({ kind: "simulated", readsTables: [], recordsOutbox: true });
    expect(calls.filter((c) => c === "exec:BEGIN")).toHaveLength(2);
    expect(calls.filter((c) => c === "exec:ROLLBACK")).toHaveLength(2);
  });

  it("returns ok:false with world.error when DDL fails", async () => {
    const { exec } = fakeExec(undefined, true);
    const r = await validateWorld(exec, { ddl: DDL, seedSql: "", tools: [sqlTool("x", ["SELECT 1"])] });
    expect(r.ok).toBe(false);
    expect(r.world.ddlOk).toBe(false);
    expect(r.world.error).toContain("ddl boom");
  });

  it("returns ok:false when DDL is unsafe", async () => {
    const { exec, calls } = fakeExec();
    const r = await validateWorld(exec, { ddl: "CREATE EXTENSION foo;", seedSql: "", tools: [] });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("uses exampleArgs over schema examples and marks simulated tools", async () => {
    const { exec, calls } = fakeExec();
    const sim: ToolSpec = { ...sqlTool("s", []), binding: { kind: "simulated", instructions: "", readsTables: [], recordsOutbox: false } };
    const r = await validateWorld(exec, { ddl: DDL, seedSql: "", tools: [sqlTool("g", ["SELECT :id"]), sim], exampleArgs: { g: { id: 42 } } });
    expect(r.tools.s!.status).toBe("simulated");
    expect(calls.some((c) => c.startsWith("query:SELECT $1"))).toBe(true);
  });
});

describe("validateWorld (PGlite)", () => {
  it("validates tools and leaves the seed untouched", async () => {
    const db = new PGlite();
    const exec = createPgliteExec(db);
    const tools = [
      sqlTool("get_item", ["SELECT * FROM items WHERE id = :id"]),
      sqlTool("add_item", ["INSERT INTO items (id, name) VALUES (:id + 100, 'n') RETURNING *"], "write"),
      sqlTool("broken", ["SELECT nope FROM items WHERE id = :id"]),
    ];
    const r = await validateWorld(exec, { ddl: "CREATE TABLE items (id int primary key, name text);", seedSql: "INSERT INTO items VALUES (1, 'a');", tools });
    expect(r.ok).toBe(true);
    expect(r.tools.get_item!.status).toBe("ok");
    expect(r.tools.add_item!.status).toBe("ok");
    expect(r.tools.broken!.status).toBe("downgraded");
    const rows = await exec.query("SELECT count(*)::int AS n FROM items");
    expect(rows[0]!.n).toBe(1);
    await db.close();
  });
});

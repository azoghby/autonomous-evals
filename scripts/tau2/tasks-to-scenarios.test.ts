import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { SandboxScenario, type ToolSpec } from "../../packages/core/src/sandbox/spec";
import { buildTau2Retail } from "../../packages/core/src/sandbox/ingest/tau2-retail";
import { WORLD_PREAMBLE_SQL } from "../../packages/core/src/sandbox/runtime/world-sql";
import { buildSuite, type Suite } from "./tasks-to-scenarios";
import { gateScenario, WRITE_TOOLS } from "./scenario-gate";
import type { Db, Task } from "./convert-retail";

const SUITE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/envs/tau2-retail/scenarios.json");
const haveSuite = existsSync(SUITE_PATH);

describe.skipIf(!haveSuite)("tau2 retail scenarios (committed suite)", () => {
  let suite: Suite;
  let pg: PGlite;
  let tools: Map<string, ToolSpec>;

  beforeAll(async () => {
    suite = JSON.parse(readFileSync(SUITE_PATH, "utf8")) as Suite;
    const { spec } = await buildTau2Retail();
    tools = new Map(spec.tools.map((t) => [t.name, t]));
    pg = new PGlite();
    await pg.exec(WORLD_PREAMBLE_SQL);
    await pg.exec(`INSERT INTO sandbox_clock (id, frozen_now) VALUES (1, '${spec.state.frozenNow}')`);
    await pg.exec(spec.state.ddl);
    await pg.exec(spec.state.seedSql);
  }, 120_000);

  it("has the consumer shape and a representative mix", () => {
    expect(suite.envId).toBe("tau2_retail");
    expect(suite.source).toBe("tau2-bench tasks.json @033bf08");
    expect(suite.accepted.length).toBeGreaterThanOrEqual(8);
    expect(new Set(suite.accepted.map((s) => s.id)).size).toBe(suite.accepted.length);
    for (const d of suite.dropped) expect(d.reason.length).toBeGreaterThan(0);
    const kinds = new Set(Object.values(suite.gold).flatMap((g) => g.map((a) => a.name)));
    for (const k of WRITE_TOOLS) expect(kinds.has(k), k).toBe(true);
    expect(suite.accepted.some((s) => s.expectRefusal)).toBe(true);
  });

  it("every accepted scenario is schema-valid, oracleValidated and carries its tau2 task id", () => {
    for (const s of suite.accepted) {
      expect(SandboxScenario.safeParse(s).success, s.id).toBe(true);
      expect(s.oracleValidated).toBe(true);
      expect(s.id).toMatch(/^sx_tau2_retail_task_\d+$/);
      expect(s.title).toContain(`task ${s.id.replace("sx_tau2_retail_task_", "")}`);
      expect(s.fixtureSql).toBe("");
      expect(s.stateAssertions.every((a) => a.sql.trimStart().startsWith("SELECT"))).toBe(true);
    }
  });

  it("passes the deterministic gate: gold replay satisfies all assertions, null agent fails, mutation flips", async () => {
    for (const s of suite.accepted) {
      const gate = await gateScenario(pg, tools, s, suite.gold[s.id] ?? []);
      expect(gate.reasons, s.id).toEqual([]);
      expect(gate.ok).toBe(true);
    }
    // rollback must leave the seed untouched
    expect((await pg.query("SELECT count(*)::int AS n FROM orders WHERE status = 'cancelled' AND cancel_reason IS NOT NULL AND id = '#W9348897'")).rows[0]).toEqual({ n: 0 });
  });

  it("the gate rejects a vacuous scenario, a wrong expectation, and a gold action that cannot run", async () => {
    const base = suite.accepted.find((s) => s.id === "sx_tau2_retail_task_38")!;
    const gold = suite.gold[base.id]!;
    const vacuous = { ...base, stateAssertions: base.stateAssertions.map((a) => ({ ...a, sql: "SELECT true AS ok" })) };
    expect((await gateScenario(pg, tools, vacuous, gold)).ok).toBe(false);
    const wrong = { ...base, stateAssertions: base.stateAssertions.map((a, i) => (i === 0 ? { ...a, sql: a.sql.replace("'cancelled'", "'delivered'") } : a)) };
    expect((await gateScenario(pg, tools, wrong, gold)).ok).toBe(false);
    const bad = gold.map((a) => ({ ...a, arguments: { ...a.arguments, order_id: "#W0000000" } }));
    expect((await gateScenario(pg, tools, base, bad)).ok).toBe(false);
  });
});

/** Optional: regenerate from a local tau2-bench clone and require byte-equal output with the committed suite. */
const dbPath = process.env.TAU2_RETAIL_DB;
describe.skipIf(!dbPath || !haveSuite)("tau2 retail scenarios (regeneration)", () => {
  it("regenerates the committed suite", async () => {
    const db = JSON.parse(readFileSync(dbPath!, "utf8")) as Db;
    const tasks = JSON.parse(readFileSync(resolve(dirname(dbPath!), "tasks.json"), "utf8")) as Task[];
    const fresh = await buildSuite(db, tasks);
    expect(JSON.parse(JSON.stringify(fresh))).toEqual(JSON.parse(readFileSync(SUITE_PATH, "utf8")));
  }, 120_000);
});

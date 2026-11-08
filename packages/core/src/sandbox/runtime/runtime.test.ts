import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { BranchInfo, NeonBranchManager, SqlConn, SqlConnector } from "./types";
import { createNeonSandboxRuntime } from "./runtime";
import { WORLD_PREAMBLE_SQL, clockSql } from "./world-sql";
import { TINY_DDL, TINY_SEED, tinyEnv, tinyScenario } from "./__fixtures__/tiny-env";

function fakeBranches() {
  const log: string[] = [];
  let n = 0;
  const live = new Set<string>();
  const mgr: NeonBranchManager = {
    async createBranch({ name, parentId, expiresAt }) {
      const id = `br-fake-${++n}`;
      live.add(id);
      log.push(`create ${id} parent=${parentId} ttl=${expiresAt ? "yes" : "no"} name=${name}`);
      return { branchId: id, name, parentId } satisfies BranchInfo;
    },
    async connectionUri(branchId, db) { return `postgres://u:p@${branchId}.fake.test/${db}`; },
    async resetFromParent(branchId, parentId) { log.push(`reset ${branchId} from ${parentId}`); },
    async deleteBranch(branchId) { live.delete(branchId); log.push(`delete ${branchId}`); },
    async listBranches() { return [...live].map((branchId) => ({ branchId, name: branchId })); },
    async defaultBranchId() { return "br-main"; },
  };
  return { mgr, log, live };
}

async function seededPglite(): Promise<SqlConn> {
  const db = new PGlite();
  await db.exec(WORLD_PREAMBLE_SQL);
  const c = clockSql("2026-06-01T15:00:00Z");
  await db.query(c.text, c.values);
  await db.exec(TINY_DDL + TINY_SEED);
  return {
    async query(sql, params = []) { const r = await db.query<Record<string, unknown>>(sql, params); return { rows: r.rows as never[], rowCount: r.affectedRows ?? r.rows.length }; },
    async exec(s) { await db.exec(s); },
    async close() { await db.close(); },
  };
}

function fakeConnector(adminLog: string[]): SqlConnector {
  return async (uri) => {
    const u = new URL(uri);
    const db = u.pathname.slice(1);
    const host = u.hostname.split(".")[0];
    if (db === "postgres" || db === "world" && !host.includes("pool")) {
      return {
        async query(sql) { adminLog.push(`${db}: ${sql.replace(/\s+/g, " ").slice(0, 80)}`); return { rows: [], rowCount: 0 }; },
        async exec(s) { adminLog.push(`${db}: exec ${s.length}b`); },
        async close() {},
      };
    }
    return seededPglite();
  };
}

describe("createNeonSandboxRuntime (fakes)", () => {
  it("template tier: one branch per job, CREATE DATABASE TEMPLATE per trial, drop on dispose, delete on teardown", async () => {
    const { mgr, log, live } = fakeBranches();
    const sql: string[] = [];
    const rt = createNeonSandboxRuntime({ branches: mgr, connector: fakeConnector(sql) });
    const { worldId } = await rt.prepare(tinyEnv(), "Job 42");
    expect(worldId).toBe("neon-world:br-fake-1");
    expect(log[0]).toMatch(/^create br-fake-1 parent=br-main ttl=yes name=sbx-job-42-[0-9a-f]{6}$/);
    expect(sql).toContain('postgres: CREATE DATABASE "world"');
    expect(sql.some((s) => s.startsWith('postgres: ALTER DATABASE "world" WITH ALLOW_CONNECTIONS false'))).toBe(true);

    const run = await rt.startRun(worldId, tinyEnv(), tinyScenario(), 0);
    expect(run.runId).toMatch(/^run_[0-9a-f]{16}$/);
    const create = sql.find((s) => s.includes(" TEMPLATE \"world\""))!;
    expect(create).toMatch(/^postgres: CREATE DATABASE "trial_[0-9a-f]{16}" TEMPLATE "world"$/);
    expect((await run.callTool("get_order", { order_id: "ord_1" })).result).toMatchObject({ id: "ord_1" });
    await run.dispose();
    expect(sql.at(-1)).toMatch(/^postgres: DROP DATABASE IF EXISTS "trial_[0-9a-f]{16}" WITH \(FORCE\)$/);

    await rt.teardown(worldId);
    expect(live.size).toBe(0);
  });

  it("rejects unsafe customer SQL before provisioning anything", async () => {
    const { mgr, log } = fakeBranches();
    const rt = createNeonSandboxRuntime({ branches: mgr, connector: fakeConnector([]) });
    const env = tinyEnv();
    await expect(rt.prepare({ ...env, state: { ...env.state, ddl: "CREATE EXTENSION dblink;" } }, "j")).rejects.toThrow();
    expect(log).toEqual([]);
    await expect(rt.startRun("neon-world:br-x", env, tinyScenario({ fixtureSql: "DROP DATABASE world" }), 0)).rejects.toThrow();
    await expect(rt.startRun("not-a-world", env, tinyScenario(), 0)).rejects.toThrow(/invalid worldId/);
  });

  it("branch_pool tier: reuses leaves and resets them from the job branch", async () => {
    const { mgr, log, live } = fakeBranches();
    const rt = createNeonSandboxRuntime({ branches: mgr, connector: fakeConnector([]), tier: "branch_pool", poolSize: 1 });
    const { worldId } = await rt.prepare(tinyEnv(), "pool");
    const r1 = await rt.startRun(worldId, tinyEnv(), tinyScenario(), 0);
    // Pool is full: the second run waits for the leaf to be released.
    const pending = rt.startRun(worldId, tinyEnv(), tinyScenario(), 1);
    await r1.dispose();
    const r2 = await pending;
    await r2.dispose();
    expect(log.filter((l) => l.startsWith("create"))).toHaveLength(2);
    expect(log).toContain("reset br-fake-2 from br-fake-1");
    await rt.teardown(worldId);
    expect(log.slice(-2)).toEqual(["delete br-fake-2", "delete br-fake-1"]);
    expect(live.size).toBe(0);
  });
});

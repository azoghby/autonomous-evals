/**
 * LIVE: provisions a real Neon branch. Run with
 *   SANDBOX_LIVE=1 npx vitest run packages/core/src/sandbox/runtime/runtime.live.test.ts
 * Needs NEON_API_KEY + NEON_PROJECT_ID (.env). Always deletes what it creates.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "dotenv";
import type { EnvironmentSpec } from "../spec";
import { neonConnector } from "./db";
import { neonBranchManagerFromEnv } from "./neon-branches";
import { createNeonSandboxRuntime, type RuntimeTimingEvent } from "./runtime";
import { TINY_DDL, TINY_SEED, tinyEnv, tinyScenario } from "./__fixtures__/tiny-env";

config({ path: resolve(__dirname, "../../../../../.env"), quiet: true });
const LIVE = process.env.SANDBOX_LIVE === "1";
const ACME = resolve(__dirname, "../../../../../data/envs/acme-support");

/** Tiny world in public; acme-support (if present) loaded alongside in schema `acme` to prove it provisions. */
function liveEnv(): { env: EnvironmentSpec; acme: boolean } {
  const schema = resolve(ACME, "schema.sql");
  const seed = resolve(ACME, "seed.sql");
  if (!existsSync(schema) || !existsSync(seed)) return { env: tinyEnv(), acme: false };
  const wrap = (sql: string) => `CREATE SCHEMA IF NOT EXISTS acme;\nSET search_path = acme, public;\n${sql}\n;RESET search_path;`;
  const base = tinyEnv();
  return { env: { ...base, state: { ...base.state, ddl: `${TINY_DDL}\n${wrap(readFileSync(schema, "utf8"))}`, seedSql: `${TINY_SEED}\n${wrap(readFileSync(seed, "utf8"))}` } }, acme: true };
}

describe.skipIf(!LIVE)("neon sandbox runtime (live)", () => {
  it("isolates two trials, diffs collateral writes, and cleans up", async () => {
    const timings: Array<[RuntimeTimingEvent, number]> = [];
    const branches = neonBranchManagerFromEnv();
    const runtime = createNeonSandboxRuntime({ branches, onTiming: (e, ms) => timings.push([e, ms]) });
    const { env, acme } = liveEnv();
    const t0 = performance.now();
    const { worldId } = await runtime.prepare(env, `live-${Date.now()}`);
    const branchId = worldId.split(":")[1];
    let tornDown = false;
    try {
      const fixture = tinyScenario({ id: "sx_fixture_a", fixtureSql: "INSERT INTO orders VALUES ('ord_3', 'cus_1', 500, 'delivered', sandbox_now() - interval '31 days');" });
      const [a, b] = await Promise.all([runtime.startRun(worldId, env, fixture, 0), runtime.startRun(worldId, env, tinyScenario(), 1)]);

      // A writes (expected + collateral); B must see none of it.
      expect((await a.callTool("refund_order", { order_id: "ord_1", amount_cents: 4720, reason: "damaged" })).result).toMatchObject({ status: "refunded" });
      expect((await a.callTool("delete_customer", { customer_id: "cus_2" })).result).toEqual({ count: 1 });
      expect((await a.callTool("get_order", { order_id: "ord_3" })).result).toMatchObject({ id: "ord_3" });
      expect((await b.callTool("get_order", { order_id: "ord_1" })).result).toMatchObject({ status: "delivered" });
      expect((await b.callTool("get_order", { order_id: "ord_3" })).error).toMatch(/^not_found/);

      const da = await a.diff();
      expect(da.map((d) => [d.table, d.inserted, d.updated, d.deleted])).toEqual([["customers", 0, 1, 0], ["orders", 0, 1, 0], ["refunds", 1, 0, 0]]);
      expect(await b.diff()).toEqual([]);
      expect(await a.query("SELECT count(*)::int AS n FROM sandbox_diff WHERE table_name = 'customers'")).toEqual([{ n: 1 }]);
      await expect(a.query("DELETE FROM customers")).rejects.toThrow();
      if (acme) expect((await a.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'acme'"))[0].n).toBeGreaterThan(0);

      // A few sequential trials for template-create latency.
      for (let i = 2; i < 5; i++) await (await runtime.startRun(worldId, env, tinyScenario(), i)).dispose();
      await Promise.all([a.dispose(), b.dispose()]);

      const admin = await neonConnector(await branches.connectionUri(branchId, "postgres"));
      const left = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE 'trial\\_%'");
      await admin.close();
      expect(left.rows[0].n).toBe(0);

      await runtime.teardown(worldId);
      tornDown = true;
      let present = true;
      for (let i = 0; i < 30 && present; i++) {
        present = (await branches.listBranches()).some((x) => x.branchId === branchId);
        if (present) await new Promise((r) => setTimeout(r, 1000));
      }
      expect(present).toBe(false);
    } finally {
      if (!tornDown) await runtime.teardown(worldId).catch(() => undefined);
      const summary: Record<string, number[]> = {};
      for (const [e, ms] of timings) (summary[e] ??= []).push(ms);
      console.info(`[sandbox-live] acme=${acme} total=${Math.round(performance.now() - t0)}ms`, JSON.stringify(summary));
    }
  }, 300_000);
});

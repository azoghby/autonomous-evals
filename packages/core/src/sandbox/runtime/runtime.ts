/**
 * Neon-backed SandboxRuntime.
 *  - prepare: one golden branch per job (expires_at backstop), database `world` = preamble + DDL + seed.
 *  - startRun (default "template" tier): CREATE DATABASE trial_<hash> TEMPLATE world on the job branch.
 *  - startRun ("branch_pool" tier, opt-in): leaf branches off the job branch, reset-from-parent between trials.
 *  - teardown: delete pool leaves, then the job branch.
 * worldId is self-describing ("neon-world:<branchId>") so another process can start runs on the same world;
 * the branch pool is in-process state and only works within one process.
 */
import { createHash, randomBytes } from "node:crypto";
import { EnvironmentSpec, SandboxScenario, type SandboxRun, type SandboxRuntime } from "../spec";
import type { NeonBranchManager, Simulate, SqlConn, SqlConnector } from "./types";
import { neonConnector, quoteIdent, withDatabase } from "./db";
import { neonBranchManagerFromEnv } from "./neon-branches";
import { createSandboxRun } from "./run";
import { assertSafeScript } from "./sql-text";
import { WORLD_PREAMBLE_SQL, clockSql, snapshotBaseline } from "./world-sql";

export type RuntimeTimingEvent = "branch_create" | "world_seed" | "trial_db_create" | "trial_fixture" | "trial_db_drop" | "pool_reset" | "branch_delete";

export interface NeonSandboxRuntimeOptions {
  branches?: NeonBranchManager;
  connector?: SqlConnector;
  /** Parent of job branches. Default: env NEON_SANDBOX_PARENT_BRANCH_ID, else the project's default branch. */
  parentBranchId?: string;
  /** Database that already exists on the parent (used for admin statements). Default "postgres" (always present). */
  adminDatabase?: string;
  worldDatabase?: string;
  branchTtlHours?: number;
  tier?: "template" | "branch_pool";
  poolSize?: number;
  simulate?: Simulate;
  onTiming?: (event: RuntimeTimingEvent, ms: number) => void;
}

const WORLD_PREFIX = "neon-world:";
const TEMPLATE_BUSY_RETRIES = 2;

interface PoolLeaf { branchId: string; busy: boolean; used: boolean }
interface WorldState { branchId: string; adminUri?: string; admin?: SqlConn; lock: Promise<unknown>; pool: PoolLeaf[]; poolWaiters: Array<() => void> }

export function createNeonSandboxRuntime(options: NeonSandboxRuntimeOptions = {}): SandboxRuntime {
  const branches = options.branches ?? neonBranchManagerFromEnv();
  const connector = options.connector ?? neonConnector;
  const adminDb = options.adminDatabase ?? "postgres";
  const worldDb = options.worldDatabase ?? "world";
  const ttlMs = (options.branchTtlHours ?? 24) * 3_600_000;
  const tier = options.tier ?? "template";
  const poolSize = options.poolSize ?? 4;
  const worlds = new Map<string, WorldState>();

  const time = async <T>(event: RuntimeTimingEvent, fn: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    try { return await fn(); } finally { options.onTiming?.(event, Math.round(performance.now() - t)); }
  };

  function world(worldId: string): WorldState {
    if (!worldId.startsWith(WORLD_PREFIX)) throw new Error("invalid worldId");
    const branchId = worldId.slice(WORLD_PREFIX.length);
    if (!/^br-[a-z0-9-]+$/.test(branchId)) throw new Error("invalid worldId");
    let w = worlds.get(branchId);
    if (!w) { w = { branchId, lock: Promise.resolve(), pool: [], poolWaiters: [] }; worlds.set(branchId, w); }
    return w;
  }

  /** Per-world serialization of admin statements (CREATE/DROP DATABASE). */
  function locked<T>(w: WorldState, fn: () => Promise<T>): Promise<T> {
    const next = w.lock.then(fn);
    w.lock = next.catch(() => undefined);
    return next;
  }

  async function admin(w: WorldState): Promise<SqlConn> {
    if (w.admin) return w.admin;
    w.adminUri ??= await branches.connectionUri(w.branchId, adminDb);
    w.admin = await connector(w.adminUri);
    return w.admin;
  }

  async function adminQuery(w: WorldState, sql: string): Promise<void> {
    try {
      await (await admin(w)).query(sql);
    } catch (e) {
      // A dead socket: reconnect once. SQL errors are rethrown as-is on the second attempt.
      if (!isConnectionError(e)) throw e;
      await w.admin?.close().catch(() => undefined);
      w.admin = undefined;
      await (await admin(w)).query(sql);
    }
  }

  function assertEnvSafe(env: EnvironmentSpec): void {
    assertSafeScript(env.state.ddl, "state.ddl");
    assertSafeScript(env.state.seedSql, "state.seedSql");
    for (const t of env.tools) {
      if (t.binding.kind === "sql") t.binding.statements.forEach((s, i) => assertSafeScript(s, `tool ${t.name} statement ${i}`));
    }
  }

  async function seedWorld(uri: string, env: EnvironmentSpec): Promise<void> {
    const conn = await connector(uri);
    try {
      await conn.exec(WORLD_PREAMBLE_SQL);
      const clock = clockSql(env.state.frozenNow);
      await conn.query(clock.text, clock.values);
      await conn.exec(env.state.ddl);
      if (env.state.seedSql.trim()) await conn.exec(env.state.seedSql);
    } finally {
      await conn.close();
    }
  }

  async function prepare(rawEnv: EnvironmentSpec, jobId: string): Promise<{ worldId: string }> {
    const env = EnvironmentSpec.parse(rawEnv);
    assertEnvSafe(env);
    const parentId = options.parentBranchId ?? process.env.NEON_SANDBOX_PARENT_BRANCH_ID ?? (await branches.defaultBranchId());
    const name = `sbx-${slug(jobId)}-${randomBytes(3).toString("hex")}`;
    const branch = await time("branch_create", () => branches.createBranch({ name, parentId, expiresAt: new Date(Date.now() + ttlMs) }));
    const worldId = `${WORLD_PREFIX}${branch.branchId}`;
    try {
      const w = world(worldId);
      await time("world_seed", async () => {
        await adminQuery(w, `CREATE DATABASE ${quoteIdent(worldDb)}`);
        await seedWorld(withDatabase(w.adminUri!, worldDb), env);
        // Neon background workers can attach to a fresh database and make TEMPLATE copies fail with
        // 55006 ("being accessed by other users"); closing the template to connections avoids that (measured).
        await adminQuery(w, `ALTER DATABASE ${quoteIdent(worldDb)} WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`);
      });
      return { worldId };
    } catch (e) {
      await teardown(worldId).catch(() => undefined);
      throw e;
    }
  }

  async function createTrialDb(w: WorldState, dbName: string): Promise<void> {
    await locked(w, async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          // CREATE DATABASE ... TEMPLATE fails if anything is connected to the template.
          await adminQuery(w, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${worldDb.replace(/'/g, "''")}' AND pid <> pg_backend_pid()`);
          await adminQuery(w, `CREATE DATABASE ${quoteIdent(dbName)} TEMPLATE ${quoteIdent(worldDb)}`);
          return;
        } catch (e) {
          if (pgCode(e) !== "55006" || attempt >= TEMPLATE_BUSY_RETRIES) throw e;
          await sleep(100 * 2 ** attempt);
        }
      }
    });
  }

  async function dropTrialDb(w: WorldState, dbName: string): Promise<void> {
    await locked(w, () => adminQuery(w, `DROP DATABASE IF EXISTS ${quoteIdent(dbName)} WITH (FORCE)`));
  }

  async function openTrial(uri: string, env: EnvironmentSpec, scenario: SandboxScenario, runId: string, onDispose: () => Promise<void>): Promise<SandboxRun> {
    const conn = await connector(uri);
    try {
      await time("trial_fixture", async () => {
        if (scenario.fixtureSql.trim()) await conn.exec(scenario.fixtureSql);
        await snapshotBaseline(conn);
      });
    } catch (e) {
      await conn.close().catch(() => undefined);
      await onDispose().catch(() => undefined);
      throw e;
    }
    return createSandboxRun({ runId, conn, env, scenario, simulate: options.simulate, onDispose });
  }

  async function startRun(worldId: string, rawEnv: EnvironmentSpec, rawScenario: SandboxScenario, trial: number): Promise<SandboxRun> {
    const env = EnvironmentSpec.parse(rawEnv);
    const scenario = SandboxScenario.parse(rawScenario);
    assertSafeScript(scenario.fixtureSql, `scenario ${scenario.id} fixtureSql`);
    const w = world(worldId);
    const hash = createHash("sha256").update(`${worldId}|${scenario.id}|${trial}|${randomBytes(8).toString("hex")}`).digest("hex").slice(0, 16);
    const runId = `run_${hash}`;
    if (tier === "branch_pool") return startPooledRun(w, env, scenario, runId);

    const dbName = `trial_${hash}`;
    await time("trial_db_create", () => createTrialDb(w, dbName));
    w.adminUri ??= await branches.connectionUri(w.branchId, adminDb);
    let dropped = false;
    const drop = async () => {
      if (dropped) return;
      dropped = true;
      await time("trial_db_drop", () => dropTrialDb(w, dbName));
    };
    return openTrial(withDatabase(w.adminUri, dbName), env, scenario, runId, drop);
  }

  async function acquireLeaf(w: WorldState): Promise<PoolLeaf> {
    for (;;) {
      const free = w.pool.find((l) => !l.busy);
      if (free) { free.busy = true; return free; }
      if (w.pool.length < poolSize) {
        const leaf: PoolLeaf = { branchId: "", busy: true, used: false };
        w.pool.push(leaf);
        try {
          const b = await branches.createBranch({ name: `sbx-pool-${w.branchId.slice(3)}-${w.pool.length}-${randomBytes(2).toString("hex")}`, parentId: w.branchId, expiresAt: new Date(Date.now() + ttlMs) });
          leaf.branchId = b.branchId;
          return leaf;
        } catch (e) {
          w.pool.splice(w.pool.indexOf(leaf), 1);
          throw e;
        }
      }
      await new Promise<void>((resolve) => w.poolWaiters.push(resolve));
    }
  }

  async function startPooledRun(w: WorldState, env: EnvironmentSpec, scenario: SandboxScenario, runId: string): Promise<SandboxRun> {
    const leaf = await acquireLeaf(w);
    const release = async () => {
      leaf.busy = false;
      w.poolWaiters.shift()?.();
    };
    try {
      // Leaves start as a copy of the job branch; a used leaf is reset to it (connection string stays stable).
      if (leaf.used) await time("pool_reset", () => branches.resetFromParent(leaf.branchId, w.branchId));
      leaf.used = true;
      // The template was closed to connections in prepare(); a leaf uses `world` directly, so reopen it there.
      const leafAdmin = await connector(await branches.connectionUri(leaf.branchId, adminDb));
      try {
        await leafAdmin.query(`ALTER DATABASE ${quoteIdent(worldDb)} WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`);
      } finally {
        await leafAdmin.close();
      }
      const uri = await branches.connectionUri(leaf.branchId, worldDb);
      return await openTrial(uri, env, scenario, runId, release);
    } catch (e) {
      await release();
      throw e;
    }
  }

  async function teardown(worldId: string): Promise<void> {
    const w = world(worldId);
    await w.lock;
    await w.admin?.close().catch(() => undefined);
    w.admin = undefined;
    for (const leaf of w.pool.filter((l) => l.branchId)) await branches.deleteBranch(leaf.branchId);
    w.pool = [];
    await time("branch_delete", () => branches.deleteBranch(w.branchId));
    worlds.delete(w.branchId);
  }

  return { prepare, startRun, teardown };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "job";
}
function pgCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}
function isConnectionError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /Connection terminated|not queryable|ECONNRESET|socket|WebSocket|Client was closed/i.test(msg) && !pgCode(e)?.match(/^[0-9A-Z]{5}$/);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

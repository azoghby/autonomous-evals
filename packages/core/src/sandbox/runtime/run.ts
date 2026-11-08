/**
 * One trial's isolated world: tool executor (bindings + faults), read-only grader queries, diff, outbox.
 * Independent of how the database was provisioned (template DB, pooled branch, or PGlite in tests).
 */
import type { EnvironmentSpec, SandboxRun, SandboxScenario, StateDiff, ToolCallRecord, ToolSpec } from "../spec";
import type { SimulatedOutput, Simulate, SqlConn, StateSnapshot } from "./types";
import { FaultScheduler, applyPostFault, argsKey, preExecutionFault } from "./faults";
import { coerceObjectArgs, validateJsonSchema } from "./json-schema";
import { assertReadOnlySql, compileNamedParams } from "./sql-text";
import { snapshotSql } from "./simulate";
import { readDiff, readOutbox, refreshDiff } from "./world-sql";

export const TOOL_STATEMENT_TIMEOUT_MS = 5_000;
export const QUERY_STATEMENT_TIMEOUT_MS = 5_000;
export const MAX_QUERY_ROWS = 5_000;
const MAX_ERROR_CHARS = 500;

type SqlBinding = Extract<ToolSpec["binding"], { kind: "sql" }>;
type SimBinding = Extract<ToolSpec["binding"], { kind: "simulated" }>;

export interface RunOptions {
  runId: string;
  conn: SqlConn;
  env: EnvironmentSpec;
  scenario: SandboxScenario;
  simulate?: Simulate;
  /** Called once after the connection is closed (drop the trial DB, release a pool branch). */
  onDispose?: () => Promise<void>;
  clock?: () => number;
}

class ToolError extends Error {}

export function createSandboxRun(opts: RunOptions): SandboxRun {
  const { conn, env, scenario } = opts;
  const clock = opts.clock ?? (() => performance.now());
  const tools = new Map(env.tools.map((t) => [t.name, t] as const));
  const scheduler = new FaultScheduler(scenario.faults ?? []);
  const priorResults = new Map<string, unknown>();
  const records: ToolCallRecord[] = [];
  let dirty = true;
  let disposed = false;
  let chain: Promise<unknown> = Promise.resolve();

  /** One session, so every DB interaction is serialized. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(() => {
      if (disposed) throw new Error("sandbox run is disposed");
      return fn();
    });
    chain = next.catch(() => undefined);
    return next;
  }

  async function inTx<T>(mode: "READ WRITE" | "READ ONLY", timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    await conn.query(`BEGIN ${mode}`);
    try {
      await conn.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`);
      const out = await fn();
      await conn.query(mode === "READ ONLY" ? "ROLLBACK" : "COMMIT");
      return out;
    } catch (e) {
      await conn.query("ROLLBACK").catch(() => undefined);
      throw e;
    }
  }

  async function runSql(binding: SqlBinding, args: Record<string, unknown>): Promise<unknown> {
    const results = await inTx("READ WRITE", TOOL_STATEMENT_TIMEOUT_MS, async () => {
      const out: Array<{ rows: Record<string, unknown>[]; rowCount: number }> = [];
      for (const stmt of binding.statements) {
        const { text, values } = compileNamedParams(stmt, args);
        out.push(await conn.query(text, values));
      }
      return out;
    });
    dirty = true;
    const idx = binding.resultFrom ?? binding.statements.length - 1;
    const picked = results[Math.min(idx, results.length - 1)];
    switch (binding.resultShape ?? "rows") {
      case "rows": return picked.rows;
      case "row":
        if (!picked.rows[0]) throw new ToolError("not_found: no matching record");
        return picked.rows[0];
      case "count": return { count: picked.rowCount };
      case "none": return { ok: true };
    }
  }

  async function runSimulated(tool: ToolSpec, binding: SimBinding, args: Record<string, unknown>): Promise<unknown> {
    if (!opts.simulate) throw new ToolError("simulator_unavailable: no simulator configured for simulated tools");
    const state: StateSnapshot = {};
    if (binding.readsTables.length) {
      await inTx("READ ONLY", TOOL_STATEMENT_TIMEOUT_MS, async () => {
        for (const t of binding.readsTables) state[t] = (await conn.query(snapshotSql(t))).rows;
      });
    }
    let out: SimulatedOutput;
    try {
      out = await opts.simulate(tool, args, state);
    } catch (e) {
      throw new ToolError(`simulator_failed: ${errMsg(e)}`);
    }
    if (tool.outputSchema) {
      const v = validateJsonSchema(tool.outputSchema, out.result);
      if (!v.ok) throw new ToolError(`simulator_output_invalid: ${v.errors.slice(0, 5).join("; ")}`);
    }
    if (binding.recordsOutbox) {
      const effects = out.sideEffects?.length ? out.sideEffects : [{ result: out.result }];
      await inTx("READ WRITE", TOOL_STATEMENT_TIMEOUT_MS, async () => {
        for (const fx of effects) {
          await conn.query("INSERT INTO sandbox_outbox(tool, args, payload) VALUES ($1, $2::jsonb, $3::jsonb)", [tool.name, JSON.stringify(args), JSON.stringify(fx)]);
        }
      });
    }
    return out.result;
  }

  async function execute(tool: ToolSpec, args: Record<string, unknown>): Promise<unknown> {
    const b = tool.binding;
    if (b.kind === "sql") return runSql(b, args);
    if (b.kind === "simulated") return runSimulated(tool, b, args);
    throw new ToolError("passthrough_not_supported: staging passthrough tools are not available in v0");
  }

  async function call(name: string, rawArgs: unknown): Promise<ToolCallRecord> {
    const started = clock();
    const seq = records.length + 1;
    const finish = (r: Omit<ToolCallRecord, "seq" | "tool" | "ms">): ToolCallRecord => {
      const rec: ToolCallRecord = { seq, tool: name, ...r, ms: Math.round(clock() - started) };
      records.push(rec);
      return { ...rec };
    };
    const tool = tools.get(name);
    if (!tool) return finish({ args: rawArgs, result: null, error: `unknown_tool: ${String(name).slice(0, 64)}` });
    const { fault } = scheduler.next(name);
    const args = coerceObjectArgs(rawArgs ?? {});
    if (!args) return finish({ args: rawArgs, result: null, error: "invalid_arguments: arguments must be a JSON object", fault: fault?.kind });
    const valid = validateJsonSchema(tool.inputSchema, args);
    if (!valid.ok) return finish({ args, result: null, error: `invalid_arguments: ${valid.errors.slice(0, 5).join("; ")}`, fault: fault?.kind });
    if (fault) {
      const pre = preExecutionFault(fault.kind);
      if (pre) return finish({ args, result: null, error: pre.error, fault: fault.kind });
    }
    const key = argsKey(name, args);
    try {
      const result = await execute(tool, args);
      const hasPrior = priorResults.has(key);
      const priorResult = priorResults.get(key);
      priorResults.set(key, result);
      if (!fault) return finish({ args, result });
      const shape = tool.binding.kind === "sql" ? tool.binding.resultShape : undefined;
      return finish({ args, result: applyPostFault(fault.kind, result, { payload: fault.payload, priorResult, hasPrior, shape }), fault: fault.kind });
    } catch (e) {
      const msg = e instanceof ToolError ? e.message : `tool_error: ${errMsg(e)}`;
      return finish({ args, result: null, error: msg.slice(0, MAX_ERROR_CHARS), fault: fault?.kind });
    }
  }

  async function ensureDiff(): Promise<void> {
    if (!dirty) return;
    await refreshDiff(conn);
    dirty = false;
  }

  return {
    runId: opts.runId,
    callTool: (name, args) => serial(() => call(name, args)).catch((e): ToolCallRecord => {
      const rec: ToolCallRecord = { seq: records.length + 1, tool: name, args, result: null, error: `runtime_error: ${errMsg(e)}`.slice(0, MAX_ERROR_CHARS), ms: 0 };
      records.push(rec);
      return { ...rec };
    }),
    query: (sql) => serial(async () => {
      const stmt = assertReadOnlySql(sql);
      await ensureDiff();
      const rows = await inTx("READ ONLY", QUERY_STATEMENT_TIMEOUT_MS, async () => (await conn.query(stmt, [])).rows);
      return rows.slice(0, MAX_QUERY_ROWS);
    }),
    diff: () => serial(async (): Promise<StateDiff[]> => {
      await ensureDiff();
      return readDiff(conn);
    }),
    outbox: () => serial(() => readOutbox(conn)),
    trajectory: () => records.map((r) => ({ ...r })),
    dispose: async () => {
      if (disposed) return;
      await chain;
      disposed = true;
      await conn.close().catch(() => undefined);
      await opts.onDispose?.();
    },
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

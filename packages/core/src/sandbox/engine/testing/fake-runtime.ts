/**
 * In-memory SandboxRuntime for engine tests. No SQL engine: tools, grader queries and mutation SQL are
 * JS handlers keyed by name / exact SQL text over a plain table map. Faults from the scenario are applied
 * exactly like the contract describes (onCall-th call of a tool).
 */
import type { EnvironmentSpec, SandboxRun, SandboxRuntime, SandboxScenario, StateDiff, ToolCallRecord } from "../../spec";
import type { MutableSandboxRun } from "../types";

export type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;
export interface ToolCtx { scenario: SandboxScenario; trial: number }
export interface FakeWorld {
  /** Base world (DDL + seed equivalent). Called fresh for every run. */
  seed(): Tables;
  /** Scenario fixtures (fixtureSql equivalent). Mutates the fresh copy. */
  fixtures?(tables: Tables, scenario: SandboxScenario): void;
  /** Tool handlers. May mutate tables. Throwing = tool-level error. */
  tools: Record<string, (tables: Tables, args: Record<string, unknown>, ctx: ToolCtx) => unknown>;
  /** Grader queries keyed by exact (trimmed) SQL. Unknown SQL throws (like a syntax error). */
  queries?: Record<string, (tables: Tables) => Row[]>;
  /** Privileged mutation SQL keyed by exact (trimmed) SQL. */
  execs?: Record<string, (tables: Tables) => void>;
  /** Primary key column (default "id"). */
  primaryKey?: string;
}

const clone = <T>(v: T): T => structuredClone(v);

export class FakeRun implements MutableSandboxRun {
  readonly runId: string;
  private readonly before: Tables;
  private readonly calls: ToolCallRecord[] = [];
  private readonly callCounts = new Map<string, number>();
  readonly outboxRows: Row[] = [];
  disposed = false;

  constructor(private readonly world: FakeWorld, readonly tables: Tables, private readonly scenario: SandboxScenario, readonly trial: number, id: string) {
    this.runId = id;
    this.before = clone(tables);
  }

  async callTool(name: string, args: unknown): Promise<ToolCallRecord> {
    if (this.disposed) throw new Error("run disposed");
    const seq = this.calls.length + 1;
    const n = (this.callCounts.get(name) ?? 0) + 1;
    this.callCounts.set(name, n);
    const fault = this.scenario.faults.find((f) => f.tool === name && f.onCall === n);
    const rec: ToolCallRecord = { seq, tool: name, args, result: null, ms: 1 };
    const handler = this.world.tools[name];
    if (!handler) {
      rec.error = `unknown tool: ${name}`;
    } else if (fault && ["http_500", "timeout", "rate_limited"].includes(fault.fault)) {
      rec.error = fault.fault;
      rec.fault = fault.fault;
    } else {
      try {
        const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
        const result = handler(this.tables, a, { scenario: this.scenario, trial: this.trial });
        if (fault?.fault === "empty_result") rec.result = [];
        else if (fault?.fault === "injected_instruction") rec.result = { data: result, note: fault.payload ?? "" };
        else rec.result = result;
        if (fault) rec.fault = fault.fault;
        if (name === "send_email") this.outboxRows.push({ tool: name, args: a });
      } catch (e) {
        rec.error = e instanceof Error ? e.message : String(e);
      }
    }
    this.calls.push(rec);
    return rec;
  }

  async query(sql: string): Promise<Row[]> {
    const q = this.world.queries?.[sql.trim()];
    if (!q) throw new Error(`fake runtime: unknown query: ${sql.slice(0, 120)}`);
    return clone(q(this.tables));
  }

  async exec(sql: string): Promise<void> {
    const m = this.world.execs?.[sql.trim()];
    if (!m) throw new Error(`fake runtime: unknown exec: ${sql.slice(0, 120)}`);
    m(this.tables);
  }

  async diff(): Promise<StateDiff[]> {
    const pk = this.world.primaryKey ?? "id";
    const names = new Set([...Object.keys(this.before), ...Object.keys(this.tables)]);
    const out: StateDiff[] = [];
    for (const table of [...names].sort()) {
      const b = new Map((this.before[table] ?? []).map((r) => [String(r[pk]), JSON.stringify(r)]));
      const a = new Map((this.tables[table] ?? []).map((r) => [String(r[pk]), JSON.stringify(r)]));
      let inserted = 0, updated = 0, deleted = 0;
      const sample: Row[] = [];
      for (const [k, v] of a) {
        if (!b.has(k)) { inserted++; sample.push(JSON.parse(v) as Row); }
        else if (b.get(k) !== v) { updated++; sample.push(JSON.parse(v) as Row); }
      }
      for (const k of b.keys()) if (!a.has(k)) deleted++;
      if (inserted + updated + deleted > 0) out.push({ table, inserted, updated, deleted, sample: sample.slice(0, 5) });
    }
    return out;
  }

  async outbox(): Promise<Row[]> { return clone(this.outboxRows); }
  trajectory(): ToolCallRecord[] { return [...this.calls]; }
  async dispose(): Promise<void> { this.disposed = true; }
}

export class FakeRuntime implements SandboxRuntime {
  readonly runs: FakeRun[] = [];
  readonly prepared: string[] = [];
  readonly tornDown: string[] = [];
  constructor(private readonly world: FakeWorld, private readonly opts: { mutable?: boolean } = {}) {}

  async prepare(_env: EnvironmentSpec, jobId: string): Promise<{ worldId: string }> {
    const worldId = `world_${jobId}`;
    this.prepared.push(worldId);
    return { worldId };
  }

  async startRun(worldId: string, _env: EnvironmentSpec, scenario: SandboxScenario, trial: number): Promise<SandboxRun> {
    if (!this.prepared.includes(worldId)) throw new Error(`unknown world ${worldId}`);
    const tables = clone(this.world.seed());
    this.world.fixtures?.(tables, scenario);
    const run = new FakeRun(this.world, tables, scenario, trial, `run_${this.runs.length + 1}`);
    this.runs.push(run);
    if (this.opts.mutable === false) {
      // Strip the privileged capability: graders/gates must cope with a plain SandboxRun.
      const plain: SandboxRun = {
        runId: run.runId,
        callTool: (n, a) => run.callTool(n, a),
        query: (s) => run.query(s),
        diff: () => run.diff(),
        outbox: () => run.outbox(),
        trajectory: () => run.trajectory(),
        dispose: () => run.dispose(),
      };
      return plain;
    }
    return run;
  }

  async teardown(worldId: string): Promise<void> { this.tornDown.push(worldId); }
}

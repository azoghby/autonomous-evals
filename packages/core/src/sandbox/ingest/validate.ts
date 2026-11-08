import type { ToolSpec } from "../spec";
import { compileNamed, assertSafeDdl } from "./safety";
import type { SqlExec } from "./types";
import { WORLD_PREAMBLE_SQL } from "../runtime/world-sql";

export type ToolStatus = "ok" | "downgraded" | "simulated" | "skipped";
export interface ValidationResult {
  ok: boolean;
  world: { ddlOk: boolean; seedOk: boolean; error?: string };
  tools: Record<string, { status: ToolStatus; warnings: string[] }>;
  downgraded: ToolSpec[];
}
export interface ValidateArgs {
  ddl: string;
  seedSql: string;
  tools: ToolSpec[];
  exampleArgs?: Record<string, Record<string, unknown>>;
  /** ISO timestamp for sandbox_clock; defaults to the current time. */
  frozenNow?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function exampleFor(schema: unknown): unknown {
  if (!isObj(schema)) return "x";
  if ("example" in schema) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === "integer" || schema.type === "number") return 1;
  if (schema.type === "boolean") return true;
  return "x";
}

function buildArgs(tool: ToolSpec, given?: Record<string, unknown>): Record<string, unknown> {
  const props = isObj(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = exampleFor(v);
  return { ...out, ...(given ?? {}) };
}

function simulatedFor(tool: ToolSpec, reason: string): ToolSpec {
  const out = tool.outputSchema ? ` Output must conform to this JSON schema: ${JSON.stringify(tool.outputSchema)}.` : "";
  const instructions = `${tool.description}${out} (SQL binding failed validation: ${reason})`.slice(0, 4_000);
  return { ...tool, binding: { kind: "simulated", instructions, readsTables: [], recordsOutbox: tool.effect !== "read" } };
}

async function dryRun(exec: SqlExec, tool: ToolSpec & { binding: { kind: "sql" } }, args: Record<string, unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const b = tool.binding;
  for (let i = 0; i < b.statements.length; i++) {
    await exec.exec("BEGIN");
    try {
      const { text, values } = compileNamed(b.statements[i]!, args);
      const rows = await exec.query(text, values);
      if (tool.effect === "read" && b.resultShape !== "none" && b.resultShape !== "count" && rows.length === 0 && i === (b.resultFrom ?? b.statements.length - 1)) {
        warnings.push("dry-run returned zero rows with example args");
      }
    } finally {
      await exec.exec("ROLLBACK");
    }
  }
  return warnings;
}

export async function validateWorld(exec: SqlExec, args: ValidateArgs): Promise<ValidationResult> {
  const result: ValidationResult = { ok: false, world: { ddlOk: false, seedOk: false }, tools: {}, downgraded: [] };
  try {
    assertSafeDdl(args.ddl);
    if (args.seedSql.trim()) assertSafeDdl(args.seedSql);
    await exec.exec(WORLD_PREAMBLE_SQL); // runtime-owned sandbox_clock / sandbox_now() / sandbox_outbox
    const now = args.frozenNow ?? new Date().toISOString();
    if (Number.isNaN(Date.parse(now)) || !/^[0-9T:.+\-Z ]+$/.test(now)) throw new Error(`invalid frozenNow: ${now}`);
    await exec.exec(`INSERT INTO sandbox_clock (id, frozen_now) VALUES (1, '${now}') ON CONFLICT (id) DO UPDATE SET frozen_now = EXCLUDED.frozen_now`);
    await exec.exec(args.ddl);
    result.world.ddlOk = true;
    if (args.seedSql.trim()) await exec.exec(args.seedSql);
    result.world.seedOk = true;
  } catch (e) {
    result.world.error = msg(e);
    return result;
  }
  result.ok = true;
  for (const tool of args.tools) {
    if (tool.binding.kind === "simulated") { result.tools[tool.name] = { status: "simulated", warnings: [] }; continue; }
    if (tool.binding.kind !== "sql") { result.tools[tool.name] = { status: "skipped", warnings: [] }; continue; }
    try {
      const warnings = await dryRun(exec, tool as ToolSpec & { binding: { kind: "sql" } }, buildArgs(tool, args.exampleArgs?.[tool.name]));
      result.tools[tool.name] = { status: "ok", warnings };
    } catch (e) {
      const reason = msg(e);
      result.tools[tool.name] = { status: "downgraded", warnings: [`SQL dry-run failed, downgraded to simulated: ${reason}`] };
      result.downgraded.push(simulatedFor(tool, reason));
    }
  }
  return result;
}

interface PgliteLike {
  exec(sql: string): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Adapt an @electric-sql/pglite PGlite instance to SqlExec. */
export function createPgliteExec(db: PgliteLike): SqlExec {
  return {
    async exec(sql) { await db.exec(sql); },
    async query(sql, params) { return (await db.query(sql, params ?? [])).rows as Array<Record<string, unknown>>; },
  };
}

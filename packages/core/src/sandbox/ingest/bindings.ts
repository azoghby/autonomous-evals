/**
 * Binding proposal: turns parsed ToolSpecs (placeholder bindings) into sql / simulated bindings.
 * Precedence per tool: hint > deterministic rule > LLM > simulated. Every SQL candidate is safety-checked
 * and validated against the tool's inputSchema and the DDL before it is accepted.
 */
import { z } from "zod";
import { generateStructured, type GatewayContext } from "../../ai/gateway";
import type { ToolSpec } from "../spec";
import type { BindingOrigin, SqlHint } from "./types";
import { assertSafeSql, maskSql, namedParams } from "./safety";

/* ---------------- DDL parsing ---------------- */

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  hasDefault: boolean;
  isPk: boolean;
  /** Literal/expression after DEFAULT, when present. */
  defaultExpr?: string;
}
export type TableInfo = { columns: ColumnInfo[] };

const COLUMN_KEYWORDS = "NOT|NULL|DEFAULT|PRIMARY|REFERENCES|CHECK|UNIQUE|GENERATED|CONSTRAINT|COLLATE";
const TYPE_RE = new RegExp(`^((?:[\\w."]+)(?:\\s+(?!(?:${COLUMN_KEYWORDS})\\b)[\\w."]+)*(?:\\s*\\([^)]*\\))?(?:\\s*\\[\\])*)`, "i");
const DEFAULT_RE = new RegExp(`\\bDEFAULT\\s+(.+?)(?=\\s+(?:NOT\\s+NULL|NULL|PRIMARY|REFERENCES|CHECK|UNIQUE|GENERATED|CONSTRAINT|COLLATE)\\b|$)`, "is");

function splitTopLevel(masked: string, from: number, to: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { parts.push([start, i]); start = i + 1; }
  }
  parts.push([start, to]);
  return parts;
}

const unquote = (s: string): string => s.replace(/^"|"$/g, "").replace(/""/g, '"');

/** Regex-level CREATE TABLE parser; table-level constraints are ignored (except PRIMARY KEY column marking). */
export function parseDdl(ddl: string): Record<string, TableInfo> {
  const masked = maskSql(ddl, { dollar: false });
  const tables: Record<string, TableInfo> = {};
  const head = /\bCREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)\s*\(/gi;
  for (const m of masked.matchAll(head)) {
    const rawName = m[1]!.split(".").pop()!;
    const name = unquote(rawName).toLowerCase();
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")" && --depth === 0) { close = i; break; }
    }
    if (close === -1) continue;
    const columns: ColumnInfo[] = [];
    const tablePk: string[] = [];
    for (const [s, e] of splitTopLevel(masked, open + 1, close)) {
      const item = ddl.slice(s, e).trim();
      const maskedItem = masked.slice(s, e).trim();
      if (!item) continue;
      const tpk = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(maskedItem);
      if (tpk) { tablePk.push(...tpk[1]!.split(",").map((c) => unquote(c.trim()).toLowerCase())); continue; }
      if (/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE|LIKE)\b/i.test(maskedItem)) continue;
      const cm = /^("[^"]+"|\w+)\s+([\s\S]*)$/.exec(item);
      if (!cm) continue;
      const rest = cm[2]!;
      const restMasked = maskedItem.slice(maskedItem.length - rest.length);
      const type = (TYPE_RE.exec(restMasked)?.[1] ?? "text").trim().replace(/\s+/g, " ");
      const isPk = /\bPRIMARY\s+KEY\b/i.test(restMasked);
      const generated = /\bGENERATED\b/i.test(restMasked);
      const dm = DEFAULT_RE.exec(rest);
      columns.push({
        name: unquote(cm[1]!).toLowerCase(),
        type,
        notNull: isPk || /\bNOT\s+NULL\b/i.test(restMasked),
        hasDefault: generated || /\bDEFAULT\b/i.test(restMasked),
        isPk,
        ...(dm ? { defaultExpr: dm[1]!.trim() } : {}),
      });
    }
    tables[name] = { columns: columns.map((c) => (tablePk.includes(c.name) ? { ...c, isPk: true, notNull: true } : c)) };
  }
  return tables;
}

/* ---------------- LLM generation ---------------- */

export type GenerateBindings = (req: { tool: ToolSpec; ddl: string }) => Promise<SqlHint | null>;

const GeneratedBinding = z.object({
  statements: z.array(z.string().min(1)).max(8),
  resultFrom: z.number().int().min(0).optional(),
  resultShape: z.enum(["rows", "row", "count", "none"]).default("rows"),
});

const BINDING_SYSTEM = [
  "You write Postgres SQL that implements one API tool against a sandbox database.",
  "Rules:",
  "- Use ONLY named parameters (:param_name) that are keys of the tool's inputSchema.properties. Never use $1, ${...} or {{...}}.",
  "- Use ONLY tables and columns that exist in the provided DDL (plus sandbox_clock, sandbox_outbox).",
  "- Read the current time via sandbox_now(), never now(), current_timestamp or clock_timestamp().",
  "- Only SELECT, INSERT, UPDATE, DELETE or WITH statements; no semicolon chaining; UPDATE/DELETE must have a WHERE clause.",
  "- No DDL, no pg_* functions, no COPY, no GRANT, no extensions.",
  "- Writes should end with RETURNING * so the result can be returned.",
  "- If the tool cannot be implemented faithfully with SQL on these tables, return an empty statements array.",
  "resultShape: row = first row, rows = all rows, count = affected/row count, none = no result.",
].join("\n");

export function gatewayGenerateBindings(ctx: GatewayContext): GenerateBindings {
  return async ({ tool, ddl }) => {
    const prompt = [
      "DDL:",
      ddl,
      "",
      "Tool:",
      JSON.stringify({ name: tool.name, description: tool.description, effect: tool.effect, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }, null, 2),
    ].join("\n");
    const res = await generateStructured({ system: BINDING_SYSTEM, prompt, schema: GeneratedBinding, ctx, temperature: 0, maxOutputTokens: 1_500 });
    const { statements, resultFrom, resultShape } = res.object;
    if (statements.length === 0) return null;
    return { statements, resultShape, ...(resultFrom !== undefined ? { resultFrom } : {}) };
  };
}

/* ---------------- naming helpers ---------------- */

const singular = (w: string): string => (w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.endsWith("ses") ? w.slice(0, -2) : w.endsWith("s") ? w.slice(0, -1) : w);
const plural = (w: string): string => (w.endsWith("y") ? `${w.slice(0, -1)}ies` : w.endsWith("s") ? w : `${w}s`);

type Verb = "get" | "list" | "create" | "update";
const VERBS: Record<string, Verb> = {
  get: "get", fetch: "get", lookup: "get", find: "get", read: "get",
  list: "list", search: "list",
  create: "create", add: "create", open: "create", submit: "create", new: "create",
  update: "update", set: "update", edit: "update", patch: "update",
};

const isInternal = (t: string): boolean => t.startsWith("sandbox_");

function inferVerbNoun(toolName: string): { verb: Verb; noun: string; searchy: boolean } | null {
  const parts = toolName.toLowerCase().split("_").filter(Boolean);
  const verb = parts[0] ? VERBS[parts[0]] : undefined;
  if (!verb || parts.length < 2) return null;
  const noun = parts.slice(1).join("_").split("_by_")[0]!;
  return noun ? { verb, noun, searchy: parts[0] === "search" } : null;
}

function matchTable(noun: string, tables: Record<string, TableInfo>): string | null {
  const names = Object.keys(tables).filter((t) => !isInternal(t));
  const forms = new Set([noun, singular(noun), plural(noun), plural(singular(noun))]);
  const exact = names.find((t) => forms.has(t));
  if (exact) return exact;
  const prefix = names.filter((t) => [...forms].some((f) => t.startsWith(`${f}_`)));
  if (prefix.length === 1) return prefix[0]!;
  const tail = names.filter((t) => [...forms].some((f) => noun.endsWith(`_${f}`) && t === f));
  return tail.length === 1 ? tail[0]! : null;
}

/* ---------------- deterministic rules ---------------- */

type RuleResult = { hint: SqlHint } | { reason: string } | null;

interface InputParam { name: string; required: boolean }

function inputParams(tool: ToolSpec): InputParam[] {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
  return Object.keys(props).map((name) => ({ name, required: required.includes(name) }));
}

const hasColumn = (t: TableInfo, name: string): boolean => t.columns.some((c) => c.name === name);
const column = (t: TableInfo, name: string): ColumnInfo | undefined => t.columns.find((c) => c.name === name);
const isTimestamp = (c: ColumnInfo): boolean => /^(timestamp|timestamptz|date)\b/i.test(c.type);

/** Column an input param refers to: same-named column first, else `id`/`<noun>_id` -> id. */
function paramColumn(p: string, table: string, noun: string, t: TableInfo): string | null {
  if (hasColumn(t, p)) return p;
  if (hasColumn(t, "id") && (p === "id" || p === `${singular(table)}_id` || p === `${singular(noun)}_id`)) return "id";
  return null;
}

function applyGet(params: InputParam[], table: string, noun: string, t: TableInfo): RuleResult {
  const conds: string[] = [];
  const used = new Set<string>();
  for (const p of params) {
    const col = paramColumn(p.name, table, noun, t);
    if (!col) {
      if (p.required) return { reason: `required param "${p.name}" matches no column of ${table}` };
      continue;
    }
    if (used.has(col)) continue;
    used.add(col);
    conds.push(`${col} = :${p.name}`);
  }
  if (conds.length === 0) return { reason: `no input param matches a column of ${table}` };
  return { hint: { statements: [`SELECT * FROM ${table} WHERE ${conds.join(" AND ")} LIMIT 1`], resultShape: "row" } };
}

const SEARCH_PARAMS = new Set(["query", "q", "text", "keyword", "keywords", "search"]);
const PAGING_PARAMS = new Set(["limit", "offset", "cursor", "page", "page_size"]);

function applyList(params: InputParam[], table: string, noun: string, t: TableInfo, searchy: boolean): RuleResult {
  const conds: string[] = [];
  const used = new Set<string>();
  let hasLimit = false;
  for (const p of params) {
    if (p.name === "limit") { hasLimit = true; continue; }
    if (PAGING_PARAMS.has(p.name)) continue;
    const col = paramColumn(p.name, table, noun, t);
    if (!col) {
      if (searchy && SEARCH_PARAMS.has(p.name)) return { reason: `free-text search param "${p.name}" needs more than equality filters` };
      if (p.required) return { reason: `required param "${p.name}" matches no column of ${table}` };
      continue;
    }
    if (used.has(col)) continue;
    used.add(col);
    conds.push(p.required ? `${col} = :${p.name}` : `(CAST(:${p.name} AS ${column(t, col)!.type}) IS NULL OR ${col} = :${p.name})`);
  }
  const ts = t.columns.find(isTimestamp);
  const order = [ts ? `${ts.name} DESC` : null, hasColumn(t, "id") ? "id DESC" : null].filter(Boolean);
  const sql = [
    `SELECT * FROM ${table}`,
    conds.length ? `WHERE ${conds.join(" AND ")}` : "",
    order.length ? `ORDER BY ${order.join(", ")}` : "",
    hasLimit ? "LIMIT COALESCE(CAST(:limit AS integer), 20)" : "LIMIT 20",
  ].filter(Boolean).join(" ");
  return { hint: { statements: [sql], resultShape: "rows" } };
}

function applyCreate(params: InputParam[], table: string, t: TableInfo): RuleResult {
  const cols: string[] = [];
  const vals: string[] = [];
  for (const p of params) {
    const col = column(t, p.name);
    if (!col) {
      if (p.required) return { reason: `required param "${p.name}" matches no column of ${table}` };
      continue;
    }
    cols.push(col.name);
    if (!p.required && col.notNull && col.hasDefault) {
      if (!col.defaultExpr) { cols.pop(); continue; }
      vals.push(`COALESCE(:${p.name}, ${col.defaultExpr})`);
    } else {
      vals.push(`:${p.name}`);
    }
  }
  if (cols.length === 0) return { reason: `no input param matches a column of ${table}` };
  const missing = t.columns.find((c) => c.notNull && !c.hasDefault && !cols.includes(c.name));
  if (missing) return { reason: `NOT NULL column ${table}.${missing.name} has no default and is not an input param` };
  return { hint: { statements: [`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${vals.join(", ")}) RETURNING *`], resultShape: "row" } };
}

function applyUpdate(params: InputParam[], table: string, noun: string, t: TableInfo): RuleResult {
  const idParam = params.find((p) => p.name === `${singular(noun)}_id` || p.name === `${singular(table)}_id` || p.name === "id");
  if (!idParam || !hasColumn(t, "id")) return { reason: `no id param for ${table}` };
  const sets: string[] = [];
  for (const p of params) {
    if (p === idParam) continue;
    const col = column(t, p.name);
    if (!col) {
      if (p.required) return { reason: `required param "${p.name}" matches no column of ${table}` };
      continue;
    }
    if (col.isPk || col.name === "id" || col.name === "created_at" || col.name === "updated_at") continue;
    sets.push(`${col.name} = COALESCE(:${p.name}, ${col.name})`);
  }
  if (sets.length === 0) return { reason: `no updatable input params for ${table}` };
  if (hasColumn(t, "updated_at") && !params.some((p) => p.name === "updated_at")) sets.push("updated_at = sandbox_now()");
  return { hint: { statements: [`UPDATE ${table} SET ${sets.join(", ")} WHERE id = :${idParam.name} RETURNING *`], resultShape: "row" } };
}

function deterministicRule(tool: ToolSpec, tables: Record<string, TableInfo>): RuleResult {
  const vn = inferVerbNoun(tool.name);
  if (!vn) return null;
  const table = matchTable(vn.noun, tables);
  if (!table) return null;
  const t = tables[table]!;
  const params = inputParams(tool);
  switch (vn.verb) {
    case "get": return applyGet(params, table, vn.noun, t);
    case "list": return applyList(params, table, vn.noun, t, vn.searchy);
    case "create": return applyCreate(params, table, t);
    case "update": return applyUpdate(params, table, vn.noun, t);
  }
}

/* ---------------- candidate validation ---------------- */

const NOT_TABLES = new Set(["set", "only", "lateral", "select", "values", "unnest"]);

/** Table names referenced after FROM/JOIN/INTO/UPDATE (CTE names and function calls excluded). */
function referencedTables(stmt: string): string[] {
  const masked = maskSql(stmt, { keepIdents: false });
  const ctes = new Set<string>();
  for (const m of masked.matchAll(/(?:\bWITH\s+(?:RECURSIVE\s+)?|,\s*)([A-Za-z_]\w*)\s+AS\s*(?:NOT\s+)?(?:MATERIALIZED\s*)?\(/gi)) ctes.add(m[1]!.toLowerCase());
  const out: string[] = [];
  for (const m of masked.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+("?[A-Za-z_]\w*"?(?:\s*\.\s*"?[A-Za-z_]\w*"?)?)(\s*[(),;]?)/gi)) {
    const full = m[1]!.replace(/\s+/g, "").replace(/"/g, "").toLowerCase();
    const name = full.includes(".") ? full.split(".").pop()! : full;
    const schema = full.includes(".") ? full.split(".")[0]! : "public";
    const follow = m[2]!.trim();
    const kw = m[0].split(/\s/)[0]!.toUpperCase();
    if ((kw === "FROM" || kw === "JOIN") && follow === "(") continue; // table function
    if (kw === "FROM" && follow === ")") continue; // EXTRACT(x FROM col)
    if (NOT_TABLES.has(name) || ctes.has(name)) continue;
    out.push(schema === "public" ? name : `${schema}.${name}`);
  }
  return out;
}

function validateStatements(statements: string[], tool: ToolSpec, tables: Record<string, TableInfo>): string | null {
  const props = new Set(Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>));
  const known = new Set([...Object.keys(tables), "sandbox_clock", "sandbox_outbox"]);
  if (statements.length === 0 || statements.length > 8) return "statement count must be 1..8";
  for (const s of statements) {
    try {
      assertSafeSql(s);
      for (const p of namedParams(s)) if (!props.has(p)) throw new Error(`param :${p} is not in the tool inputSchema`);
      for (const t of referencedTables(s)) if (!known.has(t)) throw new Error(`unknown table "${t}"`);
    } catch (e) {
      return (e as Error).message;
    }
  }
  return null;
}

/* ---------------- simulated fallback ---------------- */

function mentionedTables(tool: ToolSpec, tables: Record<string, TableInfo>, noun?: string): string[] {
  const ids = Object.keys(tables).filter((t) => !isInternal(t) && /^[a-z][a-z0-9_]{0,62}$/.test(t));
  const text = `${tool.name} ${tool.description} ${JSON.stringify(tool.inputSchema)} ${JSON.stringify(tool.outputSchema ?? {})}`.toLowerCase();
  const words = new Set(text.match(/[a-z][a-z0-9]*/g) ?? []);
  const found = ids.filter((t) => {
    const parts = t.split("_");
    return parts.every((p) => words.has(p) || words.has(plural(p)) || words.has(singular(p))) && (parts.length > 1 || words.has(t) || words.has(singular(t)));
  });
  const first = noun ? matchTable(noun, tables) : null;
  return [...new Set([...(first && ids.includes(first) ? [first] : []), ...found])].slice(0, 10);
}

function simulatedBinding(tool: ToolSpec, tables: Record<string, TableInfo>): ToolSpec["binding"] {
  const vn = inferVerbNoun(tool.name);
  const lines = [
    `Simulate the tool "${tool.name}": ${tool.description}`.trim(),
    "Return a realistic JSON result consistent with the current database state and the output schema; never contradict existing rows.",
    tool.outputSchema ? `Output schema: ${JSON.stringify(tool.outputSchema)}` : "",
    tool.effect !== "read" ? "Record any side effects (emails sent, charges, notifications) as rows in sandbox_outbox." : "",
  ].filter(Boolean);
  return {
    kind: "simulated",
    instructions: lines.join("\n").slice(0, 4_000),
    readsTables: mentionedTables(tool, tables, vn?.noun),
    recordsOutbox: tool.effect !== "read",
  };
}

/* ---------------- orchestration ---------------- */

export interface BindingReportEntry { origin: BindingOrigin; warnings: string[] }

function toBinding(h: SqlHint): ToolSpec["binding"] {
  return {
    kind: "sql",
    statements: h.statements.map((s) => s.trim()),
    resultShape: h.resultShape ?? "rows",
    ...(h.resultFrom !== undefined ? { resultFrom: h.resultFrom } : {}),
  };
}

export async function proposeBindings(
  tools: ToolSpec[],
  ddl: string,
  opts: { hints?: Record<string, SqlHint>; generate?: GenerateBindings } = {},
): Promise<{ tools: ToolSpec[]; report: Record<string, BindingReportEntry> }> {
  const tables = parseDdl(ddl);
  const report: Record<string, BindingReportEntry> = {};
  const out: ToolSpec[] = [];

  for (const tool of tools) {
    const warnings: string[] = [];
    const accept = (binding: ToolSpec["binding"], origin: BindingOrigin): void => {
      report[tool.name] = { origin, warnings };
      out.push({ ...tool, binding });
    };
    const tryHint = (h: SqlHint, label: string): ToolSpec["binding"] | null => {
      const err = validateStatements(h.statements, tool, tables);
      if (err) { warnings.push(`${label} rejected: ${err}`); return null; }
      if (h.resultFrom !== undefined && h.resultFrom >= h.statements.length) {
        warnings.push(`${label} rejected: resultFrom out of range`);
        return null;
      }
      return toBinding(h);
    };

    const hint = opts.hints?.[tool.name];
    if (hint) {
      const b = tryHint(hint, "hint");
      if (b) { accept(b, "hint"); continue; }
    }

    if (tool.effect === "external") {
      accept({ ...simulatedBinding(tool, tables), recordsOutbox: true } as ToolSpec["binding"], "simulated");
      continue;
    }

    const rule = deterministicRule(tool, tables);
    if (rule && "hint" in rule) {
      const b = tryHint(rule.hint, "rule");
      if (b) { accept(b, "rule"); continue; }
    }

    if (opts.generate) {
      try {
        const gen = await opts.generate({ tool, ddl });
        if (gen) {
          const b = tryHint(gen, "llm binding");
          if (b) { accept(b, "llm"); continue; }
        }
      } catch (e) {
        warnings.push(`llm binding failed: ${(e as Error).message}`);
      }
    }
    accept(simulatedBinding(tool, tables), "simulated");
  }
  return { tools: out, report };
}

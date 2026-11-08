import { createRequire } from "node:module";
import type { ToolSpec } from "../spec";
import { PLACEHOLDER_BINDING, type SqlHint } from "./types";

type Obj = Record<string, unknown>;
const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;
const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const MAX_DEPTH = 12;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseYamlOrJson(text: string): unknown {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return JSON.parse(t);
  const require = createRequire(import.meta.url);
  const yaml = require("js-yaml") as { load(s: string): unknown };
  return yaml.load(text);
}

function toDoc(input: string | object): Obj {
  const doc = typeof input === "string" ? parseYamlOrJson(input) : input;
  if (!isObj(doc)) throw new Error("OpenAPI document must be an object");
  if (!isObj(doc.paths)) throw new Error("OpenAPI document has no paths");
  return doc;
}

function lookupRef(doc: Obj, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = doc;
  for (const part of ref.slice(2).split("/")) {
    if (!isObj(cur)) return undefined;
    cur = cur[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return cur;
}

/** Recursively resolve local $refs; cycles collapse to a bare object schema. */
function resolve(doc: Obj, node: unknown, seen: readonly string[] = [], depth = 0): unknown {
  if (Array.isArray(node)) return node.map((n) => resolve(doc, n, seen, depth));
  if (!isObj(node)) return node;
  if (typeof node.$ref === "string") {
    const ref = node.$ref;
    if (seen.includes(ref) || depth > MAX_DEPTH) return { type: "object" };
    const target = lookupRef(doc, ref);
    if (target === undefined) return {};
    return resolve(doc, target, [...seen, ref], depth + 1);
  }
  const out: Obj = {};
  for (const [k, v] of Object.entries(node)) out[k] = resolve(doc, v, seen, depth + 1);
  return out;
}

function sanitizeName(id: string): string {
  let n = id.replace(/[^a-zA-Z0-9_]/g, "_");
  if (!/^[a-zA-Z_]/.test(n)) n = `_${n}`;
  return n.slice(0, 64);
}

function inferEffect(method: string, name: string, op: Obj): ToolSpec["effect"] {
  const x = op["x-effect"];
  if (x === "read" || x === "write" || x === "external") return x;
  if (/^(send|notify|email|sms|charge)/i.test(name)) return "external";
  return method === "get" || method === "head" ? "read" : "write";
}

function paramSchema(p: Obj): Obj {
  const s: Obj = isObj(p.schema) ? { ...p.schema } : {};
  if (typeof p.description === "string" && s.description === undefined) s.description = p.description;
  if (p.example !== undefined && s.example === undefined) s.example = p.example;
  if (p.default !== undefined && s.default === undefined) s.default = p.default;
  return s;
}

function buildInput(doc: Obj, pathItem: Obj, op: Obj): Obj {
  const properties: Obj = {};
  const required: string[] = [];
  const params = [...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])];
  for (const raw of params) {
    const p = resolve(doc, raw);
    if (!isObj(p) || typeof p.name !== "string") continue;
    if (p.in !== "path" && p.in !== "query") continue;
    properties[p.name] = resolve(doc, paramSchema(p));
    if ((p.required === true || p.in === "path") && !required.includes(p.name)) required.push(p.name);
  }
  const body = resolve(doc, op.requestBody);
  const json = isObj(body) && isObj(body.content) ? body.content["application/json"] : undefined;
  const bs = isObj(json) ? resolve(doc, json.schema) : undefined;
  if (isObj(bs) && isObj(bs.properties)) {
    for (const [k, v] of Object.entries(bs.properties)) properties[k] = v;
    if (Array.isArray(bs.required)) for (const r of bs.required) if (typeof r === "string" && !required.includes(r)) required.push(r);
  }
  const schema: Obj = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

function buildOutput(doc: Obj, op: Obj): Obj | undefined {
  if (!isObj(op.responses)) return undefined;
  const code = Object.keys(op.responses).sort().find((c) => /^2/.test(c));
  if (!code) return undefined;
  const res = resolve(doc, op.responses[code]);
  const json = isObj(res) && isObj(res.content) ? res.content["application/json"] : undefined;
  const s = isObj(json) ? resolve(doc, json.schema) : undefined;
  return isObj(s) ? s : undefined;
}

function* operations(doc: Obj): Generator<{ method: string; path: string; pathItem: Obj; op: Obj }> {
  for (const [path, pi] of Object.entries(doc.paths as Obj)) {
    if (!isObj(pi)) continue;
    for (const method of METHODS) {
      const op = pi[method];
      if (isObj(op)) yield { method, path, pathItem: pi, op };
    }
  }
}

export function parseOpenApi(input: string | object): ToolSpec[] {
  const doc = toDoc(input);
  const tools: ToolSpec[] = [];
  for (const { method, path, pathItem, op } of operations(doc)) {
    const M = method.toUpperCase();
    if (typeof op.operationId !== "string" || !op.operationId) {
      throw new Error(`OpenAPI operation ${M} ${path} is missing operationId`);
    }
    const name = sanitizeName(op.operationId);
    if (!NAME_RE.test(name)) throw new Error(`Cannot sanitize operationId "${op.operationId}"`);
    const description = [op.summary, op.description].filter((s): s is string => typeof s === "string" && s.length > 0).join("\n\n").slice(0, 2000);
    const outputSchema = buildOutput(doc, op);
    tools.push({
      name,
      description,
      inputSchema: buildInput(doc, pathItem, op),
      ...(outputSchema ? { outputSchema } : {}),
      effect: inferEffect(method, name, op),
      binding: PLACEHOLDER_BINDING,
      source: `openapi:${M} ${path}`.slice(0, 200),
    } as ToolSpec);
  }
  return tools;
}

export function extractSqlHints(input: string | object): Record<string, SqlHint> {
  const doc = toDoc(input);
  const hints: Record<string, SqlHint> = {};
  for (const { op } of operations(doc)) {
    const h = op["x-sandbox-sql"];
    if (typeof op.operationId !== "string" || !isObj(h) || !Array.isArray(h.statements)) continue;
    const hint: SqlHint = { statements: h.statements.filter((s): s is string => typeof s === "string") };
    if (typeof h.resultFrom === "number") hint.resultFrom = h.resultFrom;
    if (h.resultShape === "rows" || h.resultShape === "row" || h.resultShape === "count" || h.resultShape === "none") hint.resultShape = h.resultShape;
    hints[sanitizeName(op.operationId)] = hint;
  }
  return hints;
}

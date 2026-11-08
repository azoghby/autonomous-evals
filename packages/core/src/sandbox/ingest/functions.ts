import { ToolSpec } from "../spec";
import { PLACEHOLDER_BINDING } from "./types";

type Effect = ToolSpec["effect"];
const DEFAULT_SCHEMA = { type: "object", properties: {} };

export function inferEffectFromName(name: string): Effect {
  if (/^(send|notify|email|sms|charge|post|publish)/i.test(name)) return "external";
  if (/^(get|list|search|find|lookup|fetch|read|check|verify|query|show)/i.test(name)) return "read";
  return "write";
}

export function sanitizeToolName(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Tool is missing a string 'name'");
  if (!/[a-zA-Z0-9]/.test(raw)) throw new Error(`Tool name "${raw}" is empty after sanitization`);
  let n = raw.trim().replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(n)) n = `_${n}`;
  n = n.slice(0, 64);
  return n;
}

export function parseJsonInput(input: unknown, label: string): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch (e) {
    throw new Error(`${label}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function assertUnique(tools: ToolSpec[]): void {
  const seen = new Set<string>();
  for (const t of tools) {
    if (seen.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
    seen.add(t.name);
  }
}

export function toSchema(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : { ...DEFAULT_SCHEMA };
}

function parseOne(raw: unknown, index: number): ToolSpec {
  if (!isRecord(raw)) throw new Error(`Tool at index ${index} is not an object`);
  const def = isRecord(raw.function) ? raw.function : raw;
  const name = sanitizeToolName(def.name);
  const description = typeof def.description === "string" ? def.description.slice(0, 2000) : "";
  return {
    name,
    description,
    inputSchema: toSchema(def.parameters ?? def.input_schema ?? def.inputSchema),
    effect: inferEffectFromName(name),
    binding: PLACEHOLDER_BINDING,
    source: `json:${name}`,
  } as ToolSpec;
}

export function parseFunctionTools(input: string | unknown): ToolSpec[] {
  const data = parseJsonInput(input, "Function tools");
  const list = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.tools) ? data.tools : null;
  if (!list) throw new Error("Function tools: expected an array or an object with a 'tools' array");
  if (list.length === 0) throw new Error("Function tools: no tools found");
  const tools = list.map(parseOne);
  assertUnique(tools);
  return tools;
}

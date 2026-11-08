import type { ToolSpec } from "../spec";
import { PLACEHOLDER_BINDING } from "./types";
import { assertUnique, inferEffectFromName, isRecord, parseJsonInput, sanitizeToolName, toSchema } from "./functions";

function inferMcpEffect(name: string, annotations: unknown): ToolSpec["effect"] {
  const a = isRecord(annotations) ? annotations : {};
  if (a.readOnlyHint === true) return "read";
  if (a.openWorldHint === true) return "external";
  return inferEffectFromName(name);
}

function parseOne(raw: unknown, index: number): ToolSpec {
  if (!isRecord(raw)) throw new Error(`MCP tool at index ${index} is not an object`);
  const name = sanitizeToolName(raw.name);
  const spec: ToolSpec = {
    name,
    description: typeof raw.description === "string" ? raw.description.slice(0, 2000) : "",
    inputSchema: toSchema(raw.inputSchema),
    effect: inferMcpEffect(name, raw.annotations),
    binding: PLACEHOLDER_BINDING,
    source: `mcp:${name}`,
  };
  if (isRecord(raw.outputSchema)) spec.outputSchema = raw.outputSchema;
  return spec;
}

export function parseMcpTools(input: string | unknown): ToolSpec[] {
  const data = parseJsonInput(input, "MCP tools");
  const inner = isRecord(data) && isRecord(data.result) ? data.result : data;
  const list = Array.isArray(inner) ? inner : isRecord(inner) && Array.isArray(inner.tools) ? inner.tools : null;
  if (!list) throw new Error("MCP tools: expected a tools/list result, a bare array, or a JSON-RPC envelope with result.tools");
  if (list.length === 0) throw new Error("MCP tools: no tools found");
  const tools = list.map(parseOne);
  assertUnique(tools);
  return tools;
}

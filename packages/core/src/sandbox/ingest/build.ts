import { EnvironmentSpec, SANDBOX_SPEC_VERSION, type IntegrationMode, type ToolSpec, type PolicyDoc, type WorkflowSpec } from "../spec";
import { assertSafeDdl } from "./safety";
import { proposeBindings, type GenerateBindings } from "./bindings";
import { parseOpenApi, extractSqlHints } from "./openapi";
import { parseFunctionTools } from "./functions";
import { parseMcpTools } from "./mcp";
import { parsePolicies } from "./policies";
import { validateWorld, type ValidationResult } from "./validate";
import type { BindingOrigin, SqlExec } from "./types";

export interface BuildInput {
  id: string;
  name: string;
  domain: string;
  openapi?: string | object;
  functions?: unknown;
  mcpTools?: unknown;
  ddl: string;
  seedSql: string;
  frozenNow?: string;
  reportTables?: string[];
  policiesMarkdown?: string | string[];
  workflows: unknown[];
  integration?: IntegrationMode;
  generate?: GenerateBindings;
  exec?: SqlExec;
  exampleArgs?: Record<string, Record<string, unknown>>;
}
export interface BuildReport {
  bindings: Record<string, { origin: BindingOrigin; warnings: string[] }>;
  validation?: ValidationResult;
  warnings: string[];
}

const DEFAULT_INTEGRATION: IntegrationMode = { mode: "tool_loop", endpointUrl: "https://agent.example.com/v1/chat/completions", model: "agent-under-test" };

export function tablesFromDdl(ddl: string): string[] {
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  const names = new Set<string>();
  for (const m of ddl.matchAll(re)) names.add(m[1]!.toLowerCase());
  return [...names].filter((t) => !t.startsWith("sandbox_"));
}

function mergeTools(groups: ToolSpec[][]): ToolSpec[] {
  const seen = new Set<string>();
  const out: ToolSpec[] = [];
  for (const t of groups.flat()) {
    if (seen.has(t.name)) throw new Error(`Duplicate tool name across sources: ${t.name}`);
    seen.add(t.name);
    out.push(t);
  }
  return out;
}

export async function buildEnvironmentSpec(input: BuildInput): Promise<{ spec: EnvironmentSpec; report: BuildReport }> {
  const warnings: string[] = [];
  const parsed = mergeTools([
    input.openapi !== undefined ? parseOpenApi(input.openapi) : [],
    input.functions !== undefined ? parseFunctionTools(input.functions) : [],
    input.mcpTools !== undefined ? parseMcpTools(input.mcpTools) : [],
  ]);
  if (parsed.length === 0) throw new Error("No tools found in any source");
  assertSafeDdl(input.ddl);

  const hints = input.openapi !== undefined ? extractSqlHints(input.openapi) : {};
  const proposed = await proposeBindings(parsed, input.ddl, { hints, generate: input.generate });
  let tools = proposed.tools;
  const report: BuildReport = { bindings: proposed.report, warnings };
  for (const [n, r] of Object.entries(proposed.report)) for (const w of r.warnings) warnings.push(`${n}: ${w}`);

  if (input.exec) {
    const validation = await validateWorld(input.exec, { ddl: input.ddl, seedSql: input.seedSql, tools, exampleArgs: input.exampleArgs });
    report.validation = validation;
    if (!validation.ok) throw new Error(`World validation failed: ${validation.world.error ?? "unknown error"}`);
    const swap = new Map(validation.downgraded.map((t) => [t.name, t]));
    tools = tools.map((t) => swap.get(t.name) ?? t);
    for (const [n, r] of Object.entries(validation.tools)) for (const w of r.warnings) warnings.push(`${n}: ${w}`);
  }

  const mds = input.policiesMarkdown === undefined ? [] : Array.isArray(input.policiesMarkdown) ? input.policiesMarkdown : [input.policiesMarkdown];
  const policies: PolicyDoc[] = mds.map((md) => parsePolicies(md));

  const spec = EnvironmentSpec.parse({
    specVersion: SANDBOX_SPEC_VERSION,
    id: input.id,
    name: input.name,
    domain: input.domain,
    tools,
    state: { ddl: input.ddl, seedSql: input.seedSql, ...(input.frozenNow ? { frozenNow: input.frozenNow } : {}), reportTables: input.reportTables ?? tablesFromDdl(input.ddl) },
    policies,
    workflows: input.workflows as WorkflowSpec[],
    integration: input.integration ?? DEFAULT_INTEGRATION,
  });
  return { spec, report };
}

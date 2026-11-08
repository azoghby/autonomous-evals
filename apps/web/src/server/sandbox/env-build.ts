/**
 * Builds an EnvironmentSpec from wizard intake or MCP input. Prebuilt worlds come from bundled data/envs files;
 * custom worlds go through the ingest parsers (rules-only bindings, no model spend). Throws SandboxInputError
 * with a user-facing reason for anything we cannot build honestly.
 */
import { buildEnvironmentSpec, type BuildReport } from "@ae/core/sandbox/ingest/build";
import { parseFunctionTools } from "@ae/core/sandbox/ingest/functions";
import { parseMcpTools } from "@ae/core/sandbox/ingest/mcp";
import { parseOpenApi } from "@ae/core/sandbox/ingest/openapi";
import { buildPrebuiltEnv, isPrebuiltEnvId } from "@ae/core/sandbox/ingest/prebuilt";
import type { EnvironmentSpec, IntegrationMode, ToolSpec } from "@ae/core/sandbox/spec";
import type { SandboxIntakeInput } from "@/components/sandbox/contract";
import { assertRunnableIntegration, SandboxInputError } from "./target";

/** Used when the customer gives no schema: tools bind as simulated, the world still needs one table to diff. */
const STUB_DDL = "CREATE TABLE world_notes (id integer PRIMARY KEY, note text NOT NULL DEFAULT '');";

export interface BuiltEnvironment {
  spec: EnvironmentSpec;
  source: "prebuilt" | "custom";
  prebuiltId: string | null;
  warnings: string[];
}

export interface CustomWorld {
  name: string;
  domain: string;
  openapi?: string;
  functions?: unknown;
  mcpTools?: unknown;
  ddl?: string;
  seedSql?: string;
  policies: Array<{ title: string; text: string }>;
  workflows?: Array<{ name: string; description: string; tools?: string[]; invariants?: string[] }>;
  workflowNotes?: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);
const snake = (s: string, fallback: string) => {
  const v = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]+/, "").slice(0, 50);
  return v || fallback;
};

export async function buildPrebuilt(prebuiltId: string, integration: IntegrationMode): Promise<BuiltEnvironment> {
  if (!isPrebuiltEnvId(prebuiltId)) throw new SandboxInputError(`Unknown prebuilt environment: ${prebuiltId}`, 422, "prebuilt");
  assertRunnableIntegration(integration);
  const { spec, report } = await buildPrebuiltEnv(prebuiltId, integration);
  return { spec, source: "prebuilt", prebuiltId, warnings: report.warnings.slice(0, 50) };
}

function parsedTools(world: CustomWorld): ToolSpec[] {
  try {
    return [
      ...(world.openapi !== undefined ? parseOpenApi(world.openapi) : []),
      ...(world.functions !== undefined ? parseFunctionTools(world.functions) : []),
      ...(world.mcpTools !== undefined ? parseMcpTools(world.mcpTools) : []),
    ];
  } catch (e) {
    throw new SandboxInputError(`Could not parse your tools: ${message(e)}`, 422, "world.tools.content");
  }
}

export async function buildCustom(world: CustomWorld, integration: IntegrationMode): Promise<BuiltEnvironment> {
  assertRunnableIntegration(integration);
  const tools = parsedTools(world);
  if (tools.length === 0) throw new SandboxInputError("No tools found in your definitions.", 422, "world.tools.content");
  const names = tools.map((t) => t.name);
  const workflows = (world.workflows?.length ? world.workflows : [{
    name: `${world.name} requests`,
    description: world.workflowNotes?.trim() || `Help a user of ${world.name}${world.domain ? ` (${world.domain})` : ""} using the available tools, following every policy.`,
    tools: names.slice(0, 20),
  }]).map((w, i) => ({
    id: snake(w.name, `workflow_${i + 1}`),
    name: w.name.slice(0, 200),
    description: w.description.slice(0, 4_000),
    tools: (w.tools ?? names).filter((n) => names.includes(n)).slice(0, 20),
    invariants: w.invariants ?? [],
    policyRefs: [],
  }));
  const warnings: string[] = [];
  const ddl = world.ddl?.trim() ? world.ddl : STUB_DDL;
  if (!world.ddl?.trim()) warnings.push("No database schema given: tools are simulated and grading relies on the transcript only.");
  let built: { spec: EnvironmentSpec; report: BuildReport };
  try {
    built = await buildEnvironmentSpec({
      id: snake(world.name, "custom_env"),
      name: world.name.slice(0, 200),
      domain: world.domain.slice(0, 200),
      ...(world.openapi !== undefined ? { openapi: world.openapi } : {}),
      ...(world.functions !== undefined ? { functions: world.functions } : {}),
      ...(world.mcpTools !== undefined ? { mcpTools: world.mcpTools } : {}),
      ddl,
      seedSql: world.seedSql ?? "",
      policiesMarkdown: world.policies.map((p) => `# ${p.title}\n\n${p.text}`),
      workflows,
      integration,
    });
  } catch (e) {
    throw new SandboxInputError(`Could not build the sandbox world: ${message(e)}`, 422, "world");
  }
  return { spec: built.spec, source: "custom", prebuiltId: null, warnings: [...warnings, ...built.report.warnings].slice(0, 50) };
}

/** Wizard intake -> environment. */
export async function buildFromIntake(input: SandboxIntakeInput): Promise<BuiltEnvironment> {
  const integration = input.integration;
  if (input.prebuilt) {
    const env = await buildPrebuilt(input.prebuilt, integration);
    return { ...env, spec: { ...env.spec, name: input.name.slice(0, 200) || env.spec.name } };
  }
  const world = input.world;
  if (!world) throw new SandboxInputError("Describe the agent's world or pick a prebuilt environment.", 422, "world");
  if (world.data.format === "csv") throw new SandboxInputError("CSV data is not supported yet. Paste Postgres DDL or choose to infer from tool schemas.", 422, "world.data.format");
  const content = world.tools.content;
  let parsed: unknown = content;
  if (world.tools.format !== "openapi") {
    try { parsed = JSON.parse(content); } catch { throw new SandboxInputError("Tool definitions must be valid JSON.", 422, "world.tools.content"); }
  }
  return buildCustom({
    name: input.name,
    domain: input.domain,
    ...(world.tools.format === "openapi" ? { openapi: content } : world.tools.format === "function_json" ? { functions: parsed } : { mcpTools: parsed }),
    ...(world.data.format === "ddl" ? { ddl: world.data.content } : {}),
    policies: world.policies,
    workflowNotes: world.workflowNotes,
  }, integration);
}

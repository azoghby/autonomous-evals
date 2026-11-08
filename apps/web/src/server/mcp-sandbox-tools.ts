import { z } from "zod";
import type { McpCaller, McpToolResult, ToolDef } from "./mcp-tools";

/**
 * Sandbox-eval MCP tools. Register in the MCP route with `[...TOOLS, ...SANDBOX_TOOLS]`.
 * The engine (packages/core/src/sandbox/*) is not wired yet: `comingSoonSandboxService` validates
 * input and reports honestly. A real SandboxService MUST scope every read/write by `c.customerId`
 * (foreign environments/suites/runs must look identical to missing ones).
 * Type-only import above keeps this module free of server-only/db side effects.
 */

const ok = (data: Record<string, unknown>): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data,
});
const fail = (message: string, extra?: Record<string, unknown>): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }], isError: true,
});

export const MAX_OPENAPI_CHARS = 500_000;
export const MAX_FUNCTIONS_CHARS = 200_000;
export const MAX_MCP_TOOLS_CHARS = 200_000;
export const MAX_DDL_CHARS = 200_000;
export const MAX_SEED_SQL_CHARS = 2_000_000;
export const MAX_POLICY_CHARS = 100_000;
export const MAX_POLICIES = 20;
export const MAX_WORKFLOWS = 30;
export const MAX_K = 10;
export const DEFAULT_K = 5;

const FILES_TO_FIND = [
  "API spec: openapi.yaml / openapi.yml / openapi.json / swagger.* (-> openapi)",
  "Tool/function definitions: tools.ts, *.tools.json, OpenAI-style function schemas, or the tool list of your MCP server (-> functions or mcpTools)",
  "Database schema: *.sql, migrations/, prisma/schema.prisma, Drizzle schema files (convert to Postgres DDL -> ddl)",
  "Seed data: seed.sql, seeds/, fixtures (fake data only -> seedSql)",
  "Policies: docs/policies/*.md, POLICY*.md, support playbooks, refund/returns/escalation rules (-> policies)",
].join("\n- ");

const SEND_CONTENTS =
  `Look in the user's repo for these files and send their CONTENTS (the text itself), never their paths:\n- ${FILES_TO_FIND}\n` +
  "Never send real secrets, tokens, customer PII or production data; use fake seed data. `apiKeyRef` is a reference NAME, not a key.";

const Policy = z.union([
  z.string().min(1).max(MAX_POLICY_CHARS).describe("Markdown content of one policy document"),
  z.object({
    title: z.string().min(1).max(200).describe("Policy title, e.g. 'Refund policy'"),
    markdown: z.string().min(1).max(MAX_POLICY_CHARS).describe("Markdown content of the policy"),
  }),
]);

const Workflow = z.object({
  name: z.string().min(1).max(200).describe("Workflow name, e.g. 'Refund a delayed order'"),
  description: z.string().max(4_000).describe("What the agent is supposed to do in this workflow"),
  tools: z.array(z.string().max(64)).max(20).optional().describe("Tool names the workflow is expected to use, in rough order"),
  invariants: z.array(z.string().max(500)).max(20).optional().describe("Rules that must always hold, e.g. 'identity verified before any write'"),
});

const AgentConfig = z.object({
  endpointUrl: z.string().url().max(2_000).refine((u) => u.startsWith("https://"), "endpointUrl must be an https:// URL")
    .describe("HTTPS URL of the agent under test: an OpenAI-compatible chat completions endpoint that returns tool_calls"),
  model: z.string().min(1).max(200).describe("Model name sent to the endpoint"),
  apiKeyRef: z.string().max(100).regex(/^[A-Za-z0-9_.-]+$/, "apiKeyRef is a reference name, not a key").optional()
    .describe("NAME of a credential stored with Standard Evals (e.g. 'staging-agent-key'). Never paste the secret itself."),
});

export const CreateEnvironmentInput = z.object({
  name: z.string().trim().min(1).max(200).describe("Short name for this environment, e.g. 'Acme support agent'"),
  openapi: z.string().min(1).max(MAX_OPENAPI_CHARS).optional()
    .describe("FULL TEXT of openapi.yaml / openapi.json / swagger file (<= 500 KB). Contents, not a path."),
  functions: z.union([z.string().min(1).max(MAX_FUNCTIONS_CHARS), z.array(z.record(z.string(), z.unknown())).min(1).max(200)]).optional()
    .describe("Tool/function definitions as a JSON string or array (OpenAI function schemas or similar), from tools.ts / *.tools.json"),
  mcpTools: z.union([z.string().min(1).max(MAX_MCP_TOOLS_CHARS), z.array(z.record(z.string(), z.unknown())).min(1).max(200)]).optional()
    .describe("The tools/list result (JSON) of the agent's own MCP server"),
  ddl: z.string().min(1).max(MAX_DDL_CHARS).optional()
    .describe("Postgres DDL (CREATE TABLE ...) describing the data the tools act on; convert prisma/drizzle/migrations to DDL"),
  seedSql: z.string().min(1).max(MAX_SEED_SQL_CHARS).optional().describe("INSERT statements with FAKE data only"),
  policies: z.array(Policy).max(MAX_POLICIES).optional().describe("Policy documents (markdown) the agent must follow"),
  workflows: z.array(Workflow).max(MAX_WORKFLOWS).optional().describe("Workflows to test; omit to let the suite generator infer them from tools and policies"),
  agent: AgentConfig.describe("How to reach the agent under test"),
}).refine((v) => v.openapi !== undefined || v.functions !== undefined || v.mcpTools !== undefined, {
  message: "Provide at least one of openapi, functions, or mcpTools",
  path: ["openapi"],
});
export type CreateEnvironmentInput = z.infer<typeof CreateEnvironmentInput>;

const EnvironmentId = z.string().min(1).max(100).describe("environmentId returned by sandbox_create_environment");
const RunId = z.string().min(1).max(100).describe("runId returned by sandbox_run");

export const GenerateSuiteInput = z.object({ environmentId: EnvironmentId });
export const RunInput = z.object({
  environmentId: EnvironmentId,
  suiteId: z.string().min(1).max(100).describe("suiteId returned by sandbox_generate_suite, after the user approved the preview"),
  k: z.int().min(1).max(MAX_K).default(DEFAULT_K).describe(`Trials per scenario (1-${MAX_K}, default ${DEFAULT_K}); more trials give a more reliable pass^k`),
});
export const RunRefInput = z.object({ runId: RunId });

export interface SandboxService {
  createEnvironment(c: McpCaller, input: CreateEnvironmentInput): Promise<McpToolResult> | McpToolResult;
  generateSuite(c: McpCaller, environmentId: string): Promise<McpToolResult> | McpToolResult;
  run(c: McpCaller, environmentId: string, suiteId: string, k: number): Promise<McpToolResult> | McpToolResult;
  status(c: McpCaller, runId: string): Promise<McpToolResult> | McpToolResult;
  report(c: McpCaller, runId: string): Promise<McpToolResult> | McpToolResult;
}

const COMING_SOON = "Sandbox evals engine is not live yet. Nothing was created or run, and no ids were issued. Your input validated; try again after the engine ships.";
const comingSoon = (received: Record<string, unknown>): McpToolResult => ok({ status: "coming_soon", message: COMING_SOON, received });
const len = (v: string | unknown[] | undefined) => (v === undefined ? 0 : typeof v === "string" ? v.length : v.length);

/** Honest placeholder: validates, summarizes counts only (no content echo), never fabricates ids or results. */
export const comingSoonSandboxService: SandboxService = {
  createEnvironment: (_c, i) => comingSoon({
    name: i.name,
    openapiChars: len(i.openapi), functions: len(i.functions), mcpTools: len(i.mcpTools),
    ddlChars: len(i.ddl), seedSqlChars: len(i.seedSql),
    policies: i.policies?.length ?? 0, workflows: i.workflows?.length ?? 0,
    agentHost: new URL(i.agent.endpointUrl).host, agentModel: i.agent.model, hasApiKeyRef: Boolean(i.agent.apiKeyRef),
  }),
  generateSuite: (_c, environmentId) => comingSoon({ environmentId }),
  run: (_c, environmentId, suiteId, k) => comingSoon({ environmentId, suiteId, k }),
  status: (_c, runId) => comingSoon({ runId }),
  report: (_c, runId) => comingSoon({ runId }),
};

export function buildSandboxTools(service: SandboxService): ToolDef[] {
  const tools = [
    { name: "sandbox_create_environment", title: "Create a sandbox eval environment", readOnly: false, inputSchema: CreateEnvironmentInput,
      description: `Build a sandbox copy of the user's agent world to evaluate it safely: tools backed by a fake database, policies, and workflows. Step 1 of 5 (then sandbox_generate_suite, sandbox_run, sandbox_status, sandbox_report). ${SEND_CONTENTS} At least one of openapi, functions or mcpTools is required. Ask the user for the agent's HTTPS endpoint and model. Returns environmentId.`,
      run: (c: McpCaller, i: CreateEnvironmentInput) => service.createEnvironment(c, i) },
    { name: "sandbox_generate_suite", title: "Generate a sandbox test suite", readOnly: false, inputSchema: GenerateSuiteInput,
      description: "Generate a scenario suite (happy paths, boundaries, policy conflicts, adversarial users, tool failures) from an environment and return a PREVIEW. Show the preview to the user and get approval before calling sandbox_run. The files the environment was built from (openapi.yaml/json, tools/functions, SQL/prisma/drizzle schema, seed files, docs/policies/*.md) determine suite quality; if the preview looks thin, send more of them via a new sandbox_create_environment. Returns suiteId plus scenario preview.",
      run: (c: McpCaller, i: z.infer<typeof GenerateSuiteInput>) => service.generateSuite(c, i.environmentId) },
    { name: "sandbox_run", title: "Run a sandbox eval", readOnly: false, inputSchema: RunInput,
      description: `Run an approved suite against the user's agent, k trials per scenario (1-${MAX_K}, default ${DEFAULT_K}). Returns runId immediately; poll sandbox_status every 15-30 seconds. Only call after the user approved the sandbox_generate_suite preview.`,
      run: (c: McpCaller, i: z.infer<typeof RunInput>) => service.run(c, i.environmentId, i.suiteId, i.k) },
    { name: "sandbox_status", title: "Get sandbox run status", readOnly: true, inputSchema: RunRefInput,
      description: "Progress of a sandbox run (state, scenarios/trials completed). Poll every 15-30 seconds until it reports complete or failed, then call sandbox_report.",
      run: (c: McpCaller, i: z.infer<typeof RunRefInput>) => service.status(c, i.runId) },
    { name: "sandbox_report", title: "Get sandbox run report", readOnly: true, inputSchema: RunRefInput,
      description: "Reliability report for a finished run: per-workflow pass rates and pass^k, failures with the policy clause violated, state diffs, and suggested fixes. Only after sandbox_status reports complete.",
      run: (c: McpCaller, i: z.infer<typeof RunRefInput>) => service.report(c, i.runId) },
  ];
  return tools as unknown as ToolDef[];
}

export const SANDBOX_TOOLS: ToolDef[] = buildSandboxTools(comingSoonSandboxService);

/** Shared with tests/handlers: validate raw args against a tool's schema, returning a tool error on failure. */
export function validateToolInput(tool: ToolDef, raw: unknown): { ok: true; value: unknown } | { ok: false; result: McpToolResult } {
  const r = tool.inputSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, result: fail("Invalid input", { issues: z.flattenError(r.error) }) };
}

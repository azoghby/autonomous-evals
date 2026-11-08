import { z } from "zod";
import { wilsonInterval } from "@ae/core/sandbox/engine/util";
import type { McpCaller, McpToolResult, ToolDef } from "./mcp-tools";
import type { EngineSandboxService, EnvironmentInput } from "./sandbox/engine-service";
import { runStatusView } from "./sandbox/engine-service";
import { GATEWAY_TARGET_MODELS } from "./sandbox/target";

/**
 * Sandbox-eval MCP tools. Register in the MCP route with `[...TOOLS, ...SANDBOX_TOOLS]`.
 * `createMcpSandboxService(engine)` adapts the engine-backed service (scoped to `c.customerId`; foreign
 * environments/suites/runs look identical to missing ones). The engine is resolved lazily via dynamic import so this
 * module stays importable in tests (it has no server-only/db side effects at import time).
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
export const MAX_SCENARIO_IDS = 12;
export const MAX_SYSTEM_PROMPT_CHARS = 50_000;
export const GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
const GATEWAY_MODELS = Object.keys(GATEWAY_TARGET_MODELS).join(", ");

const FILES_TO_FIND = [
  "API spec: openapi.yaml / openapi.yml / openapi.json / swagger.* (-> openapi)",
  "Tool/function definitions: tools.ts, *.tools.json, OpenAI-style function schemas, or the tool list of your MCP server (-> functions or mcpTools)",
  "Database schema: *.sql, migrations/, prisma/schema.prisma, Drizzle schema files (convert to Postgres DDL -> ddl)",
  "Seed data: seed.sql, seeds/, fixtures (fake data only -> seedSql)",
  "Policies: docs/policies/*.md, POLICY*.md, support playbooks, refund/returns/escalation rules (-> policies)",
].join("\n- ");

const SEND_CONTENTS =
  `Look in the user's repo for these files and send their CONTENTS (the text itself), never their paths:\n- ${FILES_TO_FIND}\n` +
  "Never send real secrets, tokens, customer PII or production data; use fake seed data. Stored credentials (apiKeyRef) are not supported yet.";

const AGENT_TARGET_HELP =
  `Agent under test: an HTTPS OpenAI-compatible chat completions endpoint that returns tool_calls and needs no key (only tool_loop mode runs today), OR the AI Gateway target: endpointUrl ${GATEWAY_URL} with model one of: ${GATEWAY_MODELS} (we pay for those tokens within the run budget).`;

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
    .describe("HTTPS URL of the agent under test: an OpenAI-compatible chat completions endpoint that returns tool_calls, or the AI Gateway chat completions URL"),
  model: z.string().min(1).max(200).describe("Model name sent to the endpoint"),
  systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_CHARS).optional().describe("System prompt of the agent under test (optional)"),
  apiKeyRef: z.string().max(100).regex(/^[A-Za-z0-9_.-]+$/, "apiKeyRef is a reference name, not a key").optional()
    .describe("Not supported yet: stored credentials. Omit it."),
});

export const CreateEnvironmentInput = z.object({
  prebuilt: z.enum(["acme-support"]).optional().describe("Use a bundled demo world instead of sending your own files (openapi/functions/mcpTools not needed)"),
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
}).refine((v) => v.prebuilt !== undefined || v.openapi !== undefined || v.functions !== undefined || v.mcpTools !== undefined, {
  message: "Provide prebuilt, or at least one of openapi, functions, or mcpTools",
  path: ["openapi"],
});
export type CreateEnvironmentInput = z.infer<typeof CreateEnvironmentInput>;

const EnvironmentId = z.string().min(1).max(100).describe("environmentId returned by sandbox_create_environment");
const SuiteId = z.string().min(1).max(100).describe("suiteId returned by sandbox_generate_suite");
const RunId = z.string().min(1).max(100).describe("runId returned by sandbox_run");

export const GenerateSuiteInput = z.object({ environmentId: EnvironmentId });
export const RunInput = z.object({
  environmentId: EnvironmentId,
  suiteId: SuiteId.describe("suiteId returned by sandbox_generate_suite, after the user approved the preview"),
  k: z.int().min(1).max(MAX_K).default(DEFAULT_K).describe(`Trials per scenario (1-${MAX_K}, default ${DEFAULT_K}); more trials give a more reliable pass^k`),
  scenarioIds: z.array(z.string().min(1).max(100)).min(1).max(MAX_SCENARIO_IDS).optional()
    .describe(`Run exactly these scenarios (max ${MAX_SCENARIO_IDS}), even unvalidated ones. Omit to run the validated scenarios.`),
});
export const RunRefInput = z.object({ runId: RunId });
export const StatusInput = z.object({ runId: RunId.optional(), suiteId: SuiteId.optional() }).refine(
  (v) => (v.runId === undefined) !== (v.suiteId === undefined),
  { message: "Provide exactly one of runId or suiteId", path: ["runId"] },
);
export type StatusInput = z.infer<typeof StatusInput>;
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 20;
export const ListRunsInput = z.object({
  status: z.enum(["queued", "running", "complete", "failed"]).optional().describe("Only runs in this state"),
  limit: z.int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT).describe(`Page size (1-${MAX_LIST_LIMIT}, default ${DEFAULT_LIST_LIMIT})`),
  cursor: z.string().max(200).regex(/^[0-9A-Za-z:.+ -]{1,100}\|[\w-]{1,100}$/, "cursor must be a nextCursor returned by a previous call").optional()
    .describe("nextCursor from the previous page; omit for the first page"),
});
export type ListRunsInput = z.infer<typeof ListRunsInput>;

export interface SandboxService {
  createEnvironment(c: McpCaller, input: CreateEnvironmentInput): Promise<McpToolResult>;
  generateSuite(c: McpCaller, environmentId: string): Promise<McpToolResult>;
  run(c: McpCaller, args: { environmentId: string; suiteId: string; k: number; scenarioIds?: string[] }): Promise<McpToolResult>;
  status(c: McpCaller, ref: StatusInput): Promise<McpToolResult>;
  report(c: McpCaller, runId: string): Promise<McpToolResult>;
  listRuns(c: McpCaller, input: ListRunsInput): Promise<McpToolResult>;
}

export type McpEngine = Pick<EngineSandboxService, "createEnvironment" | "generateSuite" | "getDraft" | "startRun" | "getRunReport" | "listRunsPage">;
type EngineSource = McpEngine | (() => Promise<McpEngine>);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);
const round = (n: number) => Math.round(n * 1000) / 1000;

const toolErr = (err: unknown): McpToolResult => {
  if (err instanceof Error && err.name === "SandboxInputError") {
    const field = (err as { field?: string }).field;
    return fail(err.message, field ? { field } : undefined);
  }
  console.error("sandbox tool failed", err instanceof Error ? err.name : "unknown");
  return fail("Internal error");
};
const guard = async (fn: () => Promise<McpToolResult>): Promise<McpToolResult> => {
  try { return await fn(); } catch (err) { return toolErr(err); }
};

const NO_KEY_REF = `Stored credentials are not supported yet; use an endpoint that needs no key, or the AI Gateway target (endpointUrl ${GATEWAY_URL} with one of: ${GATEWAY_MODELS})`;

function parseJsonField(name: string, v: string | unknown[] | undefined): { value?: unknown; error?: string } {
  if (v === undefined || typeof v !== "string") return { value: v };
  try { return { value: JSON.parse(v) }; } catch { return { error: `${name} is not valid JSON` }; }
}

function toEnvironmentInput(i: CreateEnvironmentInput): EnvironmentInput | { error: string } {
  const integration = {
    mode: "tool_loop" as const, endpointUrl: i.agent.endpointUrl, model: i.agent.model,
    ...(i.agent.systemPrompt ? { systemPrompt: i.agent.systemPrompt } : {}),
  };
  if (i.prebuilt) return { name: i.name, prebuilt: i.prebuilt, integration };
  const fns = parseJsonField("functions", i.functions);
  if (fns.error) return { error: fns.error };
  const mcp = parseJsonField("mcpTools", i.mcpTools);
  if (mcp.error) return { error: mcp.error };
  const policies = (i.policies ?? []).map((p, idx) =>
    typeof p === "string" ? { title: `Policy ${idx + 1}`, text: p } : { title: p.title, text: p.markdown });
  return {
    name: i.name, integration,
    world: {
      ...(i.openapi !== undefined ? { openapi: i.openapi } : {}),
      ...(fns.value !== undefined ? { functions: fns.value } : {}),
      ...(mcp.value !== undefined ? { mcpTools: mcp.value } : {}),
      ...(i.ddl !== undefined ? { ddl: i.ddl } : {}),
      ...(i.seedSql !== undefined ? { seedSql: i.seedSql } : {}),
      policies,
      ...(i.workflows ? { workflows: i.workflows } : {}),
    },
  };
}

type Report = NonNullable<Awaited<ReturnType<McpEngine["getRunReport"]>>>;

function compactReport(report: Report, reportUrl: string): Record<string, unknown> {
  const scenarioMeta = new Map(report.scenarios.map((s) => [s.id, s]));
  const wfNames = new Map(report.workflows.map((w) => [w.id, w.name]));
  const trials = report.results.flatMap((r) => r.trials);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const [lo, hi] = wilsonInterval(trials.filter((t) => t.passed).length, trials.length);
  const byWf = new Map<string, Report["results"]>();
  for (const r of report.results) byWf.set(r.workflowId, [...(byWf.get(r.workflowId) ?? []), r]);
  const firstFail = trials.find((t) => !t.passed && t.transcript.length > 0);
  return {
    runId: report.runId, status: report.status, ...(report.error ? { error: report.error } : {}), k: report.k, versions: report.versions,
    summary: {
      scenarios: report.results.length,
      passAt1: round(mean(report.results.map((r) => r.passRate))),
      passHatK: round(report.results.length ? report.results.filter((r) => r.reliable).length / report.results.length : 0),
      ci95: [round(lo), round(hi)],
    },
    workflows: [...byWf].map(([id, rs]) => ({
      id, name: wfNames.get(id) ?? id, scenarios: rs.length,
      passRate: round(mean(rs.map((r) => r.passRate))), passHatK: round(rs.filter((r) => r.reliable).length / rs.length),
    })),
    scenarios: report.results.map((r) => {
      const failed = r.trials.find((t) => !t.passed);
      const meta = scenarioMeta.get(r.scenarioId);
      return {
        id: r.scenarioId, title: meta?.title ?? r.scenarioId, category: meta?.category, workflowId: r.workflowId,
        passRate: round(r.passRate), passHatK: r.reliable, ci95: [round(r.ci95[0]), round(r.ci95[1])],
        failedChecks: (failed?.checks ?? []).filter((ch) => !ch.passed).slice(0, 10).map((ch) => ({
          id: ch.id, severity: ch.severity, ...(ch.policyRef ? { policyRef: ch.policyRef } : {}), detail: clip(ch.detail, 200),
        })),
      };
    }),
    clusters: report.clusters.map((c) => ({
      id: c.id, title: clip(c.title, 200), rootCause: clip(c.rootCause, 400), attribution: c.attribution, severity: c.severity,
      ...(c.policyRef ? { policyRef: c.policyRef } : {}), scenarioIds: c.scenarioIds, trialCount: c.trialCount,
    })),
    ...(firstFail ? {
      exampleFailure: {
        scenarioId: firstFail.scenarioId, trial: firstFail.trial,
        lastTurns: firstFail.transcript.slice(-3).map((t) => ({ role: t.role, content: clip(t.content, 300) })),
      },
    } : {}),
    costUsd: (report.costMicroUsd ?? 0) / 1e6,
    reportUrl,
  };
}

/** Adapts the engine-backed service to the MCP tool surface, scoped to `c.customerId`. */
export function createMcpSandboxService(source: EngineSource): SandboxService {
  const engine = async (): Promise<McpEngine> => (typeof source === "function" ? source() : source);
  const notFound = () => fail("Not found");
  return {
    createEnvironment: (c, input) => guard(async () => {
      if (input.agent.apiKeyRef) return fail(NO_KEY_REF);
      const mapped = toEnvironmentInput(input);
      if ("error" in mapped) return fail(mapped.error);
      const env = await (await engine()).createEnvironment(c.customerId, mapped);
      return ok({
        environmentId: env.environmentId, name: env.name, source: env.source, tools: env.tools, tables: env.tables,
        policies: env.policies, workflows: env.workflows, warnings: env.warnings, next: "call sandbox_generate_suite",
      });
    }),
    generateSuite: (c, environmentId) => guard(async () => {
      const draft = await (await engine()).generateSuite(c.customerId, environmentId);
      if (!draft) return fail("Environment not found");
      return ok({
        suiteId: draft.draftId, status: draft.status,
        message: "Generating; poll sandbox_status with suiteId every 20-30 s until ready, then show the preview to the user",
      });
    }),
    run: (c, { environmentId, suiteId, k, scenarioIds }) => guard(async () => {
      const e = await engine();
      const draft = await e.getDraft(c.customerId, suiteId);
      if (!draft || draft.environmentId !== environmentId) return fail("Suite not found");
      const capped = Math.min(MAX_K, Math.max(1, Math.floor(k)));
      const out = await e.startRun(c.customerId, suiteId, { k: capped, scenarioIds, validatedOnly: !scenarioIds });
      if (!out.ok) return fail(out.error, { status: out.status });
      return ok({
        runId: out.runId, status: "queued", k: capped,
        budget: "Spend is capped per run (default $3); the run stops early with partial results if the cap is hit.",
        message: "Run queued; poll sandbox_status with runId every 20-30 s until complete or failed, then call sandbox_report",
      });
    }),
    status: (c, ref) => guard(async () => {
      const e = await engine();
      if (ref.suiteId) {
        const d = await e.getDraft(c.customerId, ref.suiteId);
        if (!d) return notFound();
        return ok({
          suiteId: d.draftId, status: d.status, ...(d.error ? { error: d.error } : {}), costUsd: (d.costMicroUsd ?? 0) / 1e6,
          ...(d.status === "ready" ? {
            preview: {
              scenarios: d.scenarios.map((s) => ({
                id: s.scenario.id, title: s.scenario.title, category: s.scenario.category, workflowId: s.scenario.workflowId,
                goal: clip(s.scenario.persona.goal, 300), validated: s.validated ?? false,
                gateReasons: (s.gateReasons ?? []).slice(0, 2).map((g) => clip(g, 200)),
              })),
            },
          } : {}),
        });
      }
      const report = await e.getRunReport(c.customerId, ref.runId ?? "");
      return report ? ok(runStatusView(report)) : notFound();
    }),
    listRuns: (c, { status, limit, cursor }) => guard(async () => {
      const page = await (await engine()).listRunsPage(c.customerId, { status, limit, cursor });
      return ok({
        runs: page.runs.map((r) => ({
          runId: r.runId, name: r.name, targetModel: r.targetModel ?? null, status: r.status, k: r.k,
          passAt1: r.passAt1 == null ? null : round(r.passAt1), passHatK: r.passHatK == null ? null : round(r.passHatK),
          createdAt: r.createdAt, url: `${c.origin}/sandbox/runs/${r.runId}`,
        })),
        nextCursor: page.nextCursor,
      });
    }),
    report: (c, runId) => guard(async () => {
      const report = await (await engine()).getRunReport(c.customerId, runId);
      if (!report) return notFound();
      if (report.status !== "complete" && report.status !== "failed") return fail("Run not finished; poll sandbox_status");
      return ok(compactReport(report, `${c.origin}/sandbox/runs/${runId}`));
    }),
  };
}

export function buildSandboxTools(service: SandboxService): ToolDef[] {
  const tools = [
    { name: "sandbox_create_environment", title: "Create a sandbox eval environment", readOnly: false, inputSchema: CreateEnvironmentInput,
      description: `Build a sandbox copy of the user's agent world to evaluate it safely: tools backed by a fake database, policies, and workflows. Step 1 of 5 (then sandbox_generate_suite, sandbox_run, sandbox_status, sandbox_report). ${SEND_CONTENTS} At least one of openapi, functions or mcpTools is required, or set prebuilt "acme-support" to try a bundled demo world. ${AGENT_TARGET_HELP} Ask the user which target to use. Returns environmentId.`,
      run: (c: McpCaller, i: CreateEnvironmentInput) => service.createEnvironment(c, i) },
    { name: "sandbox_generate_suite", title: "Generate a sandbox test suite", readOnly: false, inputSchema: GenerateSuiteInput,
      description: "Start generating a scenario suite (happy paths, boundaries, policy conflicts, adversarial users, tool failures) from an environment. Generation is asynchronous and takes minutes: returns suiteId immediately; poll sandbox_status with suiteId every 20-30 s until ready, then show the preview to the user and get approval before calling sandbox_run. If the preview looks thin, send more source files via a new sandbox_create_environment.",
      run: (c: McpCaller, i: z.infer<typeof GenerateSuiteInput>) => service.generateSuite(c, i.environmentId) },
    { name: "sandbox_run", title: "Run a sandbox eval", readOnly: false, inputSchema: RunInput,
      description: `Run an approved suite against the user's agent, k trials per scenario (1-${MAX_K}, default ${DEFAULT_K}). By default runs the validated scenarios; pass scenarioIds (max ${MAX_SCENARIO_IDS}) to choose. Returns runId immediately; poll sandbox_status with runId every 20-30 s. Spend is capped per run. Only call after the user approved the preview.`,
      run: (c: McpCaller, i: z.infer<typeof RunInput>) => service.run(c, i) },
    { name: "sandbox_status", title: "Get sandbox suite or run status", readOnly: true, inputSchema: StatusInput,
      description: "Progress of a suite (pass suiteId; returns the scenario preview when ready) or a run (pass runId; trials completed). Pass exactly one. Poll every 20-30 seconds until the suite is ready, or the run is complete or failed, then call sandbox_run or sandbox_report.",
      run: (c: McpCaller, i: StatusInput) => service.status(c, i) },
    { name: "sandbox_report", title: "Get sandbox run report", readOnly: true, inputSchema: RunRefInput,
      description: "Compact reliability report for a finished run (complete or failed): pass@1, pass^k, per-workflow and per-scenario pass rates, failed checks with the policy clause, failure clusters, cost, and a link to the full report. Only after sandbox_status reports complete or failed.",
      run: (c: McpCaller, i: z.infer<typeof RunRefInput>) => service.report(c, i.runId) },
    { name: "sandbox_list_runs", title: "List your sandbox runs", readOnly: true, inputSchema: ListRunsInput,
      description: `List the caller's own sandbox runs, newest first: runId, name, target model, status, pass@1 and pass^k (null until the run finishes), created_at and a link to the run page. Optional status filter; limit 1-${MAX_LIST_LIMIT} (default ${DEFAULT_LIST_LIMIT}); pass nextCursor back as cursor for the next page (null = last page). Use it to find a runId for sandbox_status or sandbox_report.`,
      run: (c: McpCaller, i: ListRunsInput) => service.listRuns(c, i) },
  ];
  return tools as unknown as ToolDef[];
}

/** Real tools, wired to the engine-backed service via dynamic import (keeps this module free of server-only imports). */
export const SANDBOX_TOOLS: ToolDef[] = buildSandboxTools(
  createMcpSandboxService(async () => (await import("./sandbox-service")).getSandboxService()),
);

/** Shared with tests/handlers: validate raw args against a tool's schema, returning a tool error on failure. */
export function validateToolInput(tool: ToolDef, raw: unknown): { ok: true; value: unknown } | { ok: false; result: McpToolResult } {
  const r = tool.inputSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, result: fail("Invalid input", { issues: z.flattenError(r.error) }) };
}

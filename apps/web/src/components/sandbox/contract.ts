/**
 * Sandbox Evals app contract: client-safe (no server-only imports). Built on the engine contract in
 * packages/core/src/sandbox/spec.ts; this file only adds intake/review inputs and report view-models.
 * Shared by the wizard (client pre-validation), API routes (authoritative validation) and the report page.
 */
import { z } from "zod";
import {
  IntegrationMode,
  type EvalVersions,
  type PolicyDoc,
  type SandboxScenario,
  type ScenarioResult,
  type ToolSpec,
  type TrialResult,
  type WorkflowSpec,
} from "@ae/core/sandbox/spec";

export type ConnectMode = IntegrationMode["mode"];
export type ScenarioCategory = SandboxScenario["category"];
export type Severity = "critical" | "high" | "medium" | "low";

/* ---------------- connect modes (plan §3 / §5) ---------------- */

export interface ConnectModeInfo {
  mode: ConnectMode;
  /** Short label for pickers ("Endpoint"). */
  label: string;
  /** One line: what the customer gives us. */
  summary: string;
  /** Who runs the agent loop. */
  loop: string;
  effort: string;
  bestFor: string;
}

export const CONNECT_MODES: readonly ConnectModeInfo[] = [
  { mode: "tool_loop", label: "Endpoint", summary: "An OpenAI-compatible URL that returns tool_calls. We run the tool loop.", loop: "We run it", effort: "No code changes", bestFor: "Prompt + model agents, quick start" },
  { mode: "sandbox_api", label: "Your tools, our world", summary: "Point your agent's tool base URL or MCP client at a per-run sandbox URL.", loop: "Your code", effort: "One env var", bestFor: "LangGraph, AI SDK or custom orchestration" },
  { mode: "repo", label: "Repo", summary: "We boot your agent from source in an isolated microVM, egress locked to our sandbox.", loop: "Your code, in a microVM", effort: "Repo access + start command", bestFor: "Teams without a hosted staging env" },
  { mode: "realtime_voice", label: "Voice", summary: "A realtime WebSocket: OpenAI Realtime, Gemini Live, Pipecat, LiveKit or raw PCM.", loop: "Your voice agent", effort: "Socket URL", bestFor: "Voice and phone agents" },
  { mode: "staging", label: "Staging", summary: "Your staging stack, with read-only grading checks you authorize.", loop: "Your code", effort: "Staging creds + authorization", bestFor: "Highest fidelity of your own systems" },
] as const;

export const connectModeInfo = (mode: ConnectMode): ConnectModeInfo =>
  CONNECT_MODES.find((m) => m.mode === mode) ?? CONNECT_MODES[0];

export const CATEGORY_LABELS: Record<ScenarioCategory, string> = {
  happy_path: "Happy path",
  boundary: "Boundary",
  missing_info: "Missing info",
  policy_conflict: "Policy conflict",
  adversarial_user: "Adversarial user",
  tool_failure: "Tool failure",
  injection: "Injection",
  multi_step: "Multi-step",
  ambiguity: "Ambiguity",
};
export const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS) as ScenarioCategory[];

/** Categories that measure attacks (security) rather than utility. */
export const ATTACK_CATEGORIES: readonly ScenarioCategory[] = ["injection", "adversarial_user"];

/* ---------------- intake (wizard → POST /api/sandbox/drafts) ---------------- */

export const ToolsFormat = z.enum(["openapi", "function_json", "mcp_tools"]);
export type ToolsFormat = z.infer<typeof ToolsFormat>;
export const DataFormat = z.enum(["ddl", "csv", "infer"]);
export type DataFormat = z.infer<typeof DataFormat>;

export const TOOLS_FORMAT_LABELS: Record<ToolsFormat, string> = {
  openapi: "OpenAPI (JSON or YAML)",
  function_json: "Function JSON",
  mcp_tools: "MCP tools/list",
};
export const DATA_FORMAT_LABELS: Record<DataFormat, string> = {
  ddl: "Postgres DDL",
  csv: "Sample CSV",
  infer: "Infer from tool schemas",
};

const MAX_TOOLS_CHARS = 500_000;
const MAX_DATA_CHARS = 2_000_000;

export const SandboxWorldInput = z
  .object({
    tools: z.object({ format: ToolsFormat, content: z.string().trim().min(2, "Paste your tool definitions").max(MAX_TOOLS_CHARS) }),
    data: z.object({ format: DataFormat, content: z.string().max(MAX_DATA_CHARS).default("") }),
    policies: z
      .array(z.object({ title: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(50_000) }))
      .max(20)
      .default([]),
    workflowNotes: z.string().max(4_000).default(""),
  })
  .superRefine((w, ctx) => {
    if (w.tools.format !== "openapi") {
      try {
        JSON.parse(w.tools.content);
      } catch {
        ctx.addIssue({ code: "custom", path: ["tools", "content"], message: "Must be valid JSON" });
      }
    }
    if (w.data.format !== "infer" && w.data.content.trim().length === 0) {
      ctx.addIssue({ code: "custom", path: ["data", "content"], message: "Paste DDL or CSV, or choose to infer it" });
    }
  });
export type SandboxWorldInput = z.infer<typeof SandboxWorldInput>;

/** Prebuilt sandbox worlds (bundled from data/envs; see packages/core/src/sandbox/ingest/prebuilt.ts). */
export const PREBUILT_ENVS = [
  { id: "acme-support", name: "Acme Support", summary: "E-commerce support: customers, orders, refunds, tickets and email, with refund/escalation policies and 5 workflows." },
] as const;
export const PrebuiltEnvId = z.enum(["acme-support"]);
export type PrebuiltEnvId = z.infer<typeof PrebuiltEnvId>;

/** The AI Gateway chat endpoint: when used as the target, we call it with our key (allowlisted models, metered into the run budget). */
export const GATEWAY_TARGET_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";
export const GATEWAY_TARGET_MODELS = ["openai/gpt-5-mini", "openai/gpt-5-nano", "openai/gpt-4.1-mini", "anthropic/claude-haiku-5.5", "google/gemini-2.5-flash"] as const;

export const SandboxIntakeInput = z.object({
  name: z.string().trim().min(1, "Name your agent").max(200),
  domain: z.string().trim().max(200).default(""),
  integration: IntegrationMode,
  /** Use a prebuilt world instead of describing one (world is then ignored). */
  prebuilt: PrebuiltEnvId.optional(),
  world: SandboxWorldInput.optional(),
}).superRefine((v, ctx) => {
  if (!v.prebuilt && !v.world) ctx.addIssue({ code: "custom", path: ["world"], message: "Describe the world or pick a prebuilt environment" });
});
export type SandboxIntakeInput = z.infer<typeof SandboxIntakeInput>;
export type SandboxIntakeRequest = z.input<typeof SandboxIntakeInput>;

/* ---------------- review + run ---------------- */

export const ScenarioDecision = z.enum(["pending", "accepted", "rejected"]);
export type ScenarioDecision = z.infer<typeof ScenarioDecision>;

export const ScenarioReviewInput = z.object({
  decision: ScenarioDecision,
  edits: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      personaGoal: z.string().trim().min(1).max(1_000).optional(),
    })
    .optional(),
});
export type ScenarioReviewInput = z.infer<typeof ScenarioReviewInput>;

export const StartRunInput = z.object({ k: z.number().int().min(1).max(10).default(5) });

export type SuiteStatus = "generating" | "gating" | "ready" | "failed";
export type StartRunInput = z.infer<typeof StartRunInput>;

/* ---------------- view-models ---------------- */

export interface DraftScenario {
  scenario: SandboxScenario;
  decision: ScenarioDecision;
  edited: boolean;
  /** Engine drafts: passed the automatic gates (oracle solves it, null agents fail it, graders catch mutations). */
  validated?: boolean;
  /** Engine drafts: why the gates rejected it (empty when validated). */
  gateReasons?: string[];
}

export interface EnvironmentSummary {
  tools: Array<Pick<ToolSpec, "name" | "description" | "effect" | "source">>;
  tables: string[];
  policies: PolicyDoc[];
  workflows: WorkflowSpec[];
}

export interface SandboxDraft {
  draftId: string;
  name: string;
  domain: string;
  mode: ConnectMode;
  createdAt: string;
  /** True when the scenarios are fixture sample data, not generated from the customer's inputs. Always label "Sample". */
  sample: boolean;
  /** Engine drafts are generated asynchronously; fixture drafts are always "ready". */
  status: SuiteStatus;
  error?: string;
  environmentId?: string;
  /** Model spend so far on generating + gating this suite (micro-USD). */
  costMicroUsd?: number;
  environment: EnvironmentSummary;
  scenarios: DraftScenario[];
}

export interface MediaPreview {
  attachmentId: string;
  scenarioId: string;
  kind: "image" | "document" | "audio" | "video";
  /** data: URI or same-origin URL. */
  src: string;
  alt: string;
}

export type FailureAttribution = NonNullable<TrialResult["failureAttribution"]>;

export interface FailureCluster {
  id: string;
  title: string;
  rootCause: string;
  attribution: FailureAttribution;
  severity: Severity;
  policyRef?: string;
  scenarioIds: string[];
  trialCount: number;
}

export interface VerifiedFix {
  title: string;
  summary: string;
  /** Unified diff of the patch. */
  diff: string;
  scenarioId: string;
  before: { passed: number; total: number };
  after: { passed: number; total: number };
  controlScenarios: number;
  regressions: number;
  prUrl?: string;
}

export type RunStatus = "queued" | "running" | "complete" | "failed";

export interface SandboxRunReport {
  runId: string;
  draftId: string | null;
  name: string;
  domain: string;
  mode: ConnectMode;
  status: RunStatus;
  /** True for fixture sample data. The UI must label it "Sample" and never present it as real results. */
  sample: boolean;
  createdAt: string;
  completedAt?: string;
  k: number;
  versions: EvalVersions;
  scenarios: SandboxScenario[];
  workflows: WorkflowSpec[];
  policies: PolicyDoc[];
  results: ScenarioResult[];
  clusters: FailureCluster[];
  verifiedFix: VerifiedFix | null;
  media: MediaPreview[];
  /** Engine runs: honest failure reason when status is "failed" (or a partial-run note). */
  error?: string;
  errorKind?: "fatal" | "retryable" | "budget";
  /** Engine runs: our model spend (simulator, judge, attribution, and AI Gateway target tokens), micro-USD. */
  costMicroUsd?: number;
  budgetMicroUsd?: number;
  progress?: { trialsDone: number; trialsTotal: number };
}

/** Public id of the sample report every signed-in user can open. */
export const SAMPLE_RUN_ID = "sample";

/**
 * Sandbox evals contract (v1). Shared by ingest, runtime, engine and app.
 * Changing a shape here is a cross-team change: bump SANDBOX_SPEC_VERSION and tell every owner.
 * See docs/SANDBOX_EVALS_PLAN.md.
 */
import { z } from "zod";

export const SANDBOX_SPEC_VERSION = "sandbox-spec-v1" as const;

const Id = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, "lower_snake identifier");
const JsonSchema = z.record(z.string(), z.unknown());

/* ---------------- environment (what the customer gives us, normalized) ---------------- */

/** How a tool call is executed inside the sandbox. */
export const ToolBinding = z.discriminatedUnion("kind", [
  /** Deterministic SQL against the run's branch. Params are bound by name (:order_id) from validated tool args. */
  z.object({
    kind: z.literal("sql"),
    statements: z.array(z.string().min(1)).min(1).max(8),
    /** Which statement's rows become the tool result (default: last). */
    resultFrom: z.number().int().min(0).optional(),
    resultShape: z.enum(["rows", "row", "count", "none"]).default("rows"),
  }),
  /** LLM-simulated output constrained by outputSchema + a snapshot of relevant state; side effects go to sandbox_outbox. */
  z.object({
    kind: z.literal("simulated"),
    instructions: z.string().max(4_000),
    readsTables: z.array(Id).max(10).default([]),
    recordsOutbox: z.boolean().default(false),
  }),
  /** Customer staging passthrough (mode C). URL must pass SSRF checks; credentials live encrypted, never in the spec. */
  z.object({
    kind: z.literal("passthrough"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    urlTemplate: z.string().url(),
    credentialRef: z.string().max(100).optional(),
  }),
]);
export type ToolBinding = z.infer<typeof ToolBinding>;

export const ToolSpec = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
  description: z.string().max(2_000),
  inputSchema: JsonSchema,
  outputSchema: JsonSchema.optional(),
  effect: z.enum(["read", "write", "external"]),
  binding: ToolBinding,
  /** Where this came from, for the report ("openapi:POST /refunds", "mcp:refund_order", "json:refund_order"). */
  source: z.string().max(200),
});
export type ToolSpec = z.infer<typeof ToolSpec>;

export const PolicyClause = z.object({ id: z.string().max(40), text: z.string().max(2_000) });
export const PolicyDoc = z.object({
  id: Id, title: z.string().max(200), clauses: z.array(PolicyClause).min(1).max(200),
});
export type PolicyDoc = z.infer<typeof PolicyDoc>;

export const WorkflowSpec = z.object({
  id: Id,
  name: z.string().max(200),
  description: z.string().max(4_000),
  /** Tools this workflow is expected to use, in rough order. */
  tools: z.array(z.string()).max(20),
  /** Invariants that must always hold, e.g. "identity verified before any write". Each becomes trajectory/state checks. */
  invariants: z.array(z.string().max(500)).max(20).default([]),
  policyRefs: z.array(z.string()).max(40).default([]),
});
export type WorkflowSpec = z.infer<typeof WorkflowSpec>;

export const StateSpec = z.object({
  /** Postgres DDL for the sandbox world (validated by executing on a scratch branch). No extensions, no roles, no COPY. */
  ddl: z.string().min(1).max(200_000),
  /** Frozen clock for determinism; tools read now() from sandbox_clock, never the wall clock. */
  frozenNow: z.string().datetime().default("2026-06-01T15:00:00Z"),
  /** Deterministic seed SQL (INSERTs). Fake data only. */
  seedSql: z.string().max(2_000_000),
  /** Tables graders may read; everything is diffed but only these appear in reports. */
  reportTables: z.array(Id).max(50).default([]),
});
export type StateSpec = z.infer<typeof StateSpec>;

export const IntegrationMode = z.discriminatedUnion("mode", [
  /** B: agent is an OpenAI-compatible endpoint that returns tool_calls; WE run the tool loop. Default, easiest. */
  z.object({ mode: z.literal("tool_loop"), endpointUrl: z.string().url(), model: z.string().max(200), credentialRef: z.string().max(100).optional(), systemPrompt: z.string().max(50_000).optional() }),
  /** A: agent runs its own loop and calls OUR sandbox tool API / MCP server (per-run base URL + token). We drive the user side via its chat endpoint. */
  z.object({ mode: z.literal("sandbox_api"), chatEndpointUrl: z.string().url(), credentialRef: z.string().max(100).optional() }),
  /** D: bring your repo — we boot their agent from source inside an isolated microVM (Vercel Sandbox) with tool URLs pointed at our sandbox API. */
  z.object({ mode: z.literal("repo"), repoUrl: z.string().url(), ref: z.string().max(200).default("main"), installCommand: z.string().max(500), startCommand: z.string().max(500), chatPath: z.string().max(200).default("/v1/chat/completions"), port: z.number().int().min(1).max(65535).default(3000), envRefs: z.array(z.string().max(100)).max(30).default([]) }),
  /** V: voice agent over a realtime audio socket. We stream simulated-user speech (gateway TTS / realtime models) and transcribe replies (gateway STT). */
  z.object({ mode: z.literal("realtime_voice"), wsUrl: z.string().url(), protocol: z.enum(["openai_realtime", "gemini_live", "pipecat", "livekit", "custom_pcm"]), sampleRateHz: z.number().int().default(16_000), credentialRef: z.string().max(100).optional() }),
  /** C: their staging stack; tools are passthrough bindings; grading via read-only checks they authorize. */
  z.object({ mode: z.literal("staging"), chatEndpointUrl: z.string().url(), credentialRef: z.string().max(100).optional() }),
]);
export type IntegrationMode = z.infer<typeof IntegrationMode>;

export const EnvironmentSpec = z.object({
  specVersion: z.literal(SANDBOX_SPEC_VERSION),
  id: Id,
  name: z.string().max(200),
  domain: z.string().max(200),
  tools: z.array(ToolSpec).min(1).max(60),
  state: StateSpec,
  policies: z.array(PolicyDoc).max(20).default([]),
  workflows: z.array(WorkflowSpec).min(1).max(30),
  integration: IntegrationMode,
});
export type EnvironmentSpec = z.infer<typeof EnvironmentSpec>;

/* ---------------- scenarios (generated, oracle-validated) ---------------- */

/** Synthetic media the simulated user sends, with ground truth so graders can check what the agent should have read/heard. */
export const MediaAttachment = z.object({
  id: z.string().max(40),
  kind: z.enum(["image", "document", "audio", "video"]),
  /** render = deterministic HTML/template → PNG/PDF (exact text, e.g. receipts, IDs, invoices); generate = gateway image/TTS model (photos, scenes, voices). */
  source: z.enum(["render", "generate", "fixture"]),
  prompt: z.string().max(4_000),
  model: z.string().max(120).optional(),
  /** Facts the media contains (e.g. {"total":"47.20","merchant":"Acme"}). Media is accepted only if a gateway vision/STT model reads these back (media oracle). */
  groundTruth: z.record(z.string(), z.string()).default({}),
  /** Robustness perturbations: blur, rotate, low_light, crop, jpeg, noise, accent, speed, packet_loss, background_noise. */
  perturbations: z.array(z.string().max(40)).max(6).default([]),
  /** Visual/audio prompt injection payload hidden in the media (with canary). */
  injection: z.string().max(1_000).optional(),
});
export type MediaAttachment = z.infer<typeof MediaAttachment>;

export const Persona = z.object({
  name: z.string().max(80),
  goal: z.string().max(1_000),
  /** Facts the simulated user knows; `revealWhen` lets the user withhold info until asked (realistic). */
  knowledge: z.array(z.object({ fact: z.string().max(500), revealWhen: z.enum(["upfront", "when_asked", "never"]).default("when_asked") })).max(20),
  style: z.string().max(500),
  adversarial: z.boolean().default(false),
  modality: z.enum(["text", "voice", "multimodal"]).default("text"),
  /** For voice: gateway TTS model + voice id + accent/pace; for realtime: a gateway realtime model drives the user. */
  voice: z.object({ ttsModel: z.string().max(120), voiceId: z.string().max(120).optional(), accent: z.string().max(60).optional(), pace: z.enum(["slow", "normal", "fast"]).default("normal"), interrupts: z.boolean().default(false) }).optional(),
  maxTurns: z.number().int().min(1).max(30).default(12),
});
export type Persona = z.infer<typeof Persona>;

/** Assertion over the sandbox state AFTER the run. `sql` must return exactly one row with a boolean column `ok`. */
export const StateAssertion = z.object({ id: z.string().max(40), description: z.string().max(500), sql: z.string().max(4_000), severity: z.enum(["critical", "high", "medium", "low"]) });
/** Assertion over the tool-call trajectory. */
export const TrajectoryAssertion = z.discriminatedUnion("type", [
  z.object({ id: z.string().max(40), type: z.literal("called"), tool: z.string(), description: z.string().max(500), severity: z.enum(["critical", "high", "medium", "low"]) }),
  z.object({ id: z.string().max(40), type: z.literal("not_called"), tool: z.string(), description: z.string().max(500), severity: z.enum(["critical", "high", "medium", "low"]) }),
  z.object({ id: z.string().max(40), type: z.literal("before"), first: z.string(), then: z.string(), description: z.string().max(500), severity: z.enum(["critical", "high", "medium", "low"]) }),
  z.object({ id: z.string().max(40), type: z.literal("max_calls"), tool: z.string().optional(), max: z.number().int().min(0), description: z.string().max(500), severity: z.enum(["critical", "high", "medium", "low"]) }),
]);
export const RubricItem = z.object({ id: z.string().max(40), description: z.string().max(500), policyRef: z.string().max(80).optional(), severity: z.enum(["critical", "high", "medium", "low"]) });

export const FaultInjection = z.object({
  tool: z.string(),
  onCall: z.number().int().min(1).default(1),
  fault: z.enum(["http_500", "timeout", "empty_result", "stale_data", "rate_limited", "injected_instruction"]),
  /** For injected_instruction: text planted in the tool result (indirect prompt injection), with a canary. */
  payload: z.string().max(2_000).optional(),
});

export const SandboxScenario = z.object({
  id: z.string().regex(/^sx_[a-z0-9_]{1,60}$/),
  workflowId: Id,
  title: z.string().max(200),
  category: z.enum(["happy_path", "boundary", "missing_info", "policy_conflict", "adversarial_user", "tool_failure", "injection", "multi_step", "ambiguity"]),
  persona: Persona,
  /** Scenario-specific rows inserted after the base seed (e.g. the order that is exactly 31 days old). */
  fixtureSql: z.string().max(50_000).default(""),
  faults: z.array(FaultInjection).max(5).default([]),
  attachments: z.array(MediaAttachment).max(8).default([]),
  stateAssertions: z.array(StateAssertion).max(15).default([]),
  trajectoryAssertions: z.array(TrajectoryAssertion).max(15).default([]),
  rubric: z.array(RubricItem).max(10).default([]),
  /** Tables any write outside of is "collateral damage" (auto-fail high). Empty = no writes expected. */
  allowedWriteTables: z.array(Id).max(20).default([]),
  /** AppWorld-style diff contract: changes that MUST appear vs MAY appear; anything else = collateral damage. Each is a SQL predicate over the diff view. */
  expectedChanges: z.array(z.object({ id: z.string().max(40), description: z.string().max(500), sql: z.string().max(4_000) })).max(15).default([]),
  allowedChanges: z.array(z.object({ table: Id, description: z.string().max(300) })).max(20).default([]),
  /** tau-bench r_output: facts the agent must communicate (e.g. the refund amount). Checked deterministically, judge only as fallback. */
  requiredOutputs: z.array(z.object({ id: z.string().max(40), mustMention: z.array(z.string().max(200)).min(1).max(5), description: z.string().max(300) })).max(10).default([]),
  /** Impossible-by-design: success = explicit refusal/escalation, never "nothing changed". */
  expectRefusal: z.boolean().default(false),
  /** Set by the oracle check: a privileged reference agent achieved all assertions → scenario is satisfiable. */
  oracleValidated: z.boolean().default(false),
});
export type SandboxScenario = z.infer<typeof SandboxScenario>;

/* ---------------- runtime boundary (engine ⇄ runtime) ---------------- */

/** `executed`: false when a fault (http_500/timeout/rate_limited) short-circuited the tool; true when it ran (result may still be altered by empty_result/stale_data/injected_instruction). */
export interface ToolCallRecord { seq: number; tool: string; args: unknown; result: unknown; error?: string; fault?: string; ms: number; executed?: boolean }
/** sample rows: { change: "insert"|"update"|"delete", pk, before, after } */
export interface StateDiff { table: string; inserted: number; updated: number; deleted: number; sample: Array<Record<string, unknown>> }

/** One isolated world for one trial. Implemented by sandbox/runtime. */
export interface SandboxRun {
  readonly runId: string;
  /** Execute a tool call against this run's world (applies bindings + scheduled faults). Never throws for tool-level errors: returns {error}. */
  callTool(name: string, args: unknown): Promise<ToolCallRecord>;
  /** Read-only query for graders (statement_timeout enforced, SELECT only). */
  query(sql: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
  diff(): Promise<StateDiff[]>;
  outbox(): Promise<Array<Record<string, unknown>>>;
  trajectory(): ToolCallRecord[];
  dispose(): Promise<void>;
}

export interface SandboxRuntime {
  /** Provision the job-level world once (DDL + seed), returns an opaque handle. */
  prepare(env: EnvironmentSpec, jobId: string): Promise<{ worldId: string }>;
  /** Fresh isolated copy of the world for one trial, with scenario fixtures + faults applied. */
  startRun(worldId: string, env: EnvironmentSpec, scenario: SandboxScenario, trial: number): Promise<SandboxRun>;
  teardown(worldId: string): Promise<void>;
}

/* ---------------- results ---------------- */

export interface CheckResult { id: string; kind: "state" | "trajectory" | "rubric" | "collateral" | "injection" | "perception" | "latency"; passed: boolean; severity: "critical" | "high" | "medium" | "low"; detail: string; policyRef?: string }
/** Everything that can move a score is pinned and reported (scores across versions are not comparable). */
export interface EvalVersions { spec: typeof SANDBOX_SPEC_VERSION; suiteHash: string; simulatorModel: string; judgeModel: string; envHash: string; runtime: string }
export interface TrialResult { scenarioId: string; trial: number; variant: string; versions: EvalVersions; failureAttribution?: "agent" | "simulator" | "environment" | "grader" | "unknown"; passed: boolean; checks: CheckResult[]; transcript: Array<{ role: "user" | "assistant" | "tool"; content: string }>; toolCalls: ToolCallRecord[]; diff: StateDiff[]; costMicroUsd: number; error?: string }
export interface ScenarioResult { scenarioId: string; workflowId: string; trials: TrialResult[]; passRate: number; /** pass^k: every trial passed */ reliable: boolean; ci95: [number, number] }

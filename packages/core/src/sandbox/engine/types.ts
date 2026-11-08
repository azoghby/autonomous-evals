/**
 * Engine-internal contract. Everything here sits on top of sandbox/spec.ts (sandbox-spec-v1) and is
 * private to sandbox/engine. Modules depend on these interfaces, never on each other's internals.
 */
import type { GatewayContext, generateStructured, generateText } from "../../ai/gateway";
import { resolveModel, type ModelAlias, type ModelSpec } from "../../ai/models";
import type { JsonTransport } from "../../targets/transport";
import type { CheckResult, EnvironmentSpec, SandboxRun, SandboxScenario, TrialResult } from "../spec";

/* ---------------- model access ---------------- */

/** Injectable gateway (tests pass a fake). Same signatures as packages/core/src/ai/gateway.ts. */
export interface EngineGateway {
  generateStructured: typeof generateStructured;
  generateText: typeof generateText;
}
export type ModelChoice = ModelAlias | ModelSpec;
export interface EngineDeps {
  gateway: EngineGateway;
  /** Cost sink + live remaining budget. Wrap with budgetContext() per job. */
  ctx: GatewayContext;
  /** SSRF-safe transport for customer endpoints (default: new HttpsJsonTransport with a private gate). */
  transport?: JsonTransport;
}

/** Display name for a model choice (recorded in EvalVersions). */
export function modelName(m: ModelChoice): string {
  return resolveModel(m).vercel;
}

/* ---------------- conversation ---------------- */

export type TranscriptEntry = TrialResult["transcript"][number];
/** What the simulated user is allowed to see: user/assistant text only, never tool calls. */
export interface ConversationMessage { role: "user" | "assistant"; content: string }

/* ---------------- agents (customer agent, oracle, null agents) ---------------- */

export interface AgentTurn {
  /** Final assistant text shown to the user for this turn ("" allowed). */
  reply: string;
  /** Transcript entries produced during the turn, in order (tool entries then the assistant reply). Never includes the user message. */
  transcript: TranscriptEntry[];
  /** Model spend we paid for (oracle); 0 for customer endpoints and null agents. */
  costMicroUsd: number;
  /** Set when the agent could not complete the turn (transport error code, limits). Ends the episode. */
  error?: string;
}
export interface AgentSession { send(userMessage: string): Promise<AgentTurn> }
export interface AgentStartInput { env: EnvironmentSpec; scenario: SandboxScenario; run: SandboxRun }
export interface AgentFactory {
  readonly name: string;
  start(input: AgentStartInput): AgentSession;
}

/* ---------------- user simulator ---------------- */

export type Variant = "base" | "paraphrase" | "typo" | "distractor";
export const VARIANTS: readonly Variant[] = ["base", "paraphrase", "typo", "distractor"];

export type SimulatorStatus = "continue" | "goal_achieved" | "abandoned";
export interface SimulatorTurn { message: string; status: SimulatorStatus; costMicroUsd: number }
export interface SimulatorSession {
  /** Next user message given the visible conversation so far ([] for the opening message). */
  next(conversation: ConversationMessage[]): Promise<SimulatorTurn>;
}
export interface SimulatorStartInput { env: EnvironmentSpec; scenario: SandboxScenario; variant: Variant; trial: number }
export interface SimulatorFactory {
  /** Pinned model id (recorded in EvalVersions.simulatorModel); "scripted" for the deterministic simulator. */
  readonly model: string;
  start(input: SimulatorStartInput): SimulatorSession;
}

export type StopReason = "goal_achieved" | "abandoned" | "max_turns" | "agent_error";
export interface Episode {
  transcript: TranscriptEntry[];
  conversation: ConversationMessage[];
  stopReason: StopReason;
  costMicroUsd: number;
  error?: string;
}

/* ---------------- grading ---------------- */

export interface JudgeConfig { gateway: EngineGateway; ctx: GatewayContext; model: ModelChoice }
export interface GradeInput {
  env: EnvironmentSpec;
  scenario: SandboxScenario;
  /** Graders only use query/diff/outbox/trajectory (read-only). */
  run: SandboxRun;
  transcript: TranscriptEntry[];
}
export interface GradeOptions {
  /** null/undefined = deterministic only (no judge fallback, no rubric). Gates grade with no judge. */
  judge?: JudgeConfig | null;
  /** Rubric item ids whose judge verdict is reward-bearing (judge–human agreement ≥ 0.8). Default none. */
  rewardBearingRubricIds?: readonly string[];
}
export interface GradeOutcome { checks: CheckResult[]; passed: boolean; costMicroUsd: number }

/* ---------------- generation metadata (engine-side, not part of spec v1) ---------------- */

export type MutationKind = "drop_expected" | "collateral" | "change_amount";
/** SQL that perturbs a correct final state; the verdict must flip from pass to fail. */
export interface StateMutation { id: string; kind: MutationKind; sql: string }
export interface GeneratedScenario { scenario: SandboxScenario; mutations: StateMutation[]; slot: GenerationSlot }
export interface GenerationSlot {
  workflowId: string;
  category: SandboxScenario["category"];
  /** "docId:clauseId" or undefined. */
  policyRef?: string;
  /** Impossible-by-design slot (expectRefusal). */
  impossible: boolean;
  index: number;
}

/**
 * Privileged write capability used ONLY by the grader mutation gate. Not in sandbox-spec-v1
 * (proposed: SandboxRun.exec?(sql)). Detected structurally; without it SQL mutations are skipped.
 */
export interface MutableSandboxRun extends SandboxRun { exec(sql: string): Promise<void> }
export function isMutableRun(run: SandboxRun): run is MutableSandboxRun {
  return typeof (run as Partial<MutableSandboxRun>).exec === "function";
}

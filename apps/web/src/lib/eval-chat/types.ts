/**
 * Eval copilot contract shared by the server (tools, stream, actions) and the client (useChat + generative cards).
 * Every assistant tool part is `tool-<name>` with the input/output below. Outputs are already redacted and grounded:
 * cards render them as-is and never fetch anything except the live polls noted per card.
 */
import type { UIMessage } from "ai";

export type EvalKind = "sandbox_run" | "job";
export interface EvalRef { kind: EvalKind; id: string }

/* ---------------- shared pieces ---------------- */

export interface TranscriptLine { role: "user" | "assistant" | "tool"; content: string }
export interface TimelineStep {
  /** Order inside the trial (transcript turns and tool calls interleaved by position). */
  seq: number;
  kind: "user" | "assistant" | "tool";
  label: string;
  detail: string;
  /** Tool calls only. */
  error?: string;
  fault?: string;
  ms?: number;
}
export interface DiffRow { table: string; change: "insert" | "update" | "delete"; pk: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }
export interface CheckRow { id: string; kind: string; passed: boolean; severity: "critical" | "high" | "medium" | "low"; detail: string; policyRef?: string }

/* ---------------- card payloads (tool outputs) ---------------- */

export interface ScenarioScore { id: string; title: string; category: string; passed: number; total: number; reliable: boolean }
export interface ResultsSummaryCard {
  runId: string; name: string; status: string; k: number;
  scenarios: number; trials: number;
  passAt1: number; passHatK: number; ci95: [number, number];
  costUsd: number;
  byScenario: ScenarioScore[];
  clusters: Array<{ title: string; rootCause: string; severity: string; scenarioIds: string[]; trialCount: number }>;
}

export interface JobSummaryCard {
  jobId: string; state: string; package: string; createdAt: string;
  findings: Array<{ id: string; title: string; severity: string; status: string; category: string }>;
  bySeverity: Record<string, number>;
  reportSummary: string | null;
  remediations: number;
  delivered: boolean;
}

export interface EvidenceCardData {
  scenarioId: string; scenarioTitle: string; category: string;
  trial: number; trials: number; passed: boolean;
  attribution: string | null;
  failedChecks: CheckRow[];
  /** Short excerpt around the failure (untrusted transcript text: render as plain text). */
  excerpt: TranscriptLine[];
  diff: DiffRow[];
  error: string | null;
}

export interface FindingEvidenceCard {
  findingId: string; title: string; severity: string; status: string; category: string;
  description: string; reproductions: number | null;
  evidence: Array<{ label: string; text: string }>;
  remediation: { title: string; summary: string; patch: string | null } | null;
}

export interface TrialTimelineCard { scenarioId: string; scenarioTitle: string; trial: number; passed: boolean; steps: TimelineStep[] }
export interface StateDiffCard { scenarioId: string; trial: number; tables: Array<{ table: string; inserted: number; updated: number; deleted: number }>; rows: DiffRow[] }

export interface RunCompareCard {
  base: { runId: string; name: string; createdAt: string; passAt1: number; passHatK: number; k: number };
  other: { runId: string; name: string; createdAt: string; passAt1: number; passHatK: number; k: number };
  rows: Array<{ scenarioId: string; title: string; base: { passed: number; total: number } | null; other: { passed: number; total: number } | null; change: "fixed" | "regressed" | "same" | "added" | "removed" }>;
}

export interface ExplainerCard { topic: string; title: string; body: string; example?: string; relatedScenarioIds: string[] }

export interface PromptPatchCard {
  title: string; rationale: string;
  /** Unified-style line diff: " " context, "+" added, "-" removed. */
  lines: Array<{ op: " " | "+" | "-"; text: string }>;
  after: string;
  /** Hosted target: the copilot can re-run with this prompt (via propose_rerun). */
  applyable: boolean;
}

/* ---------------- actions (propose -> confirm) ---------------- */

export type ActionKind = "add_scenario" | "rerun" | "share_report" | "rerun_finding";
export type ActionStatus = "proposed" | "executing" | "executed" | "cancelled" | "failed" | "expired";

export interface ActionBase { actionId: string; kind: ActionKind; status: ActionStatus; expiresAt: string }

/** propose_add_scenario: the scenario is being generated + gated in a new draft; Confirm runs it. Poll GET /api/sandbox/drafts/{draftId}. */
export interface ScenarioPreviewCard extends ActionBase {
  kind: "add_scenario";
  draftId: string;
  brief: string; category: string;
  /** Scenario ids present in the base run: anything else in the draft is the new scenario. */
  baseScenarioIds: string[];
  replacesScenarioId: string | null;
  k: number;
  scope: "new" | "all";
  estimate: CostEstimate;
}

export interface CostEstimate { trials: number; perTrialUsd: number; totalUsd: number; budgetUsd: number; basis: string }

/** propose_rerun: k / model / prompt / scope change. Confirm creates the suite and starts the run. */
export interface RerunCard extends ActionBase {
  kind: "rerun";
  scope: "all" | "failed" | "selected";
  scenarioIds: string[];
  k: number;
  model: string | null; currentModel: string | null;
  promptChanged: boolean;
  /** The stored replacement prompt (truncated) so the customer sees exactly what Confirm will run. */
  promptPreview?: string;
  estimate: CostEstimate;
}

export interface ShareCard extends ActionBase { kind: "share_report"; downloads: Array<{ label: string; href: string }>; shareable: boolean; reason: string | null }
export interface RerunFindingCard extends ActionBase { kind: "rerun_finding"; findingId: string; title: string }

export type ActionCard = ScenarioPreviewCard | RerunCard | ShareCard | RerunFindingCard;

/** POST /api/evals/{kind}/{id}/chat/actions/{actionId} {decision} response. RunProgress polls GET /api/sandbox/runs/{runId}. */
export interface ActionResult {
  actionId: string; status: ActionStatus;
  runId?: string; runUrl?: string; shareUrl?: string;
  error?: string;
}

/* ---------------- tool set ---------------- */

export type EvalTools = {
  get_overview: { input: Record<string, never>; output: ResultsSummaryCard | JobSummaryCard };
  explain_failure: { input: { scenarioId: string; trial?: number }; output: EvidenceCardData };
  get_trial_timeline: { input: { scenarioId: string; trial?: number }; output: TrialTimelineCard };
  get_state_diff: { input: { scenarioId: string; trial?: number }; output: StateDiffCard };
  compare_runs: { input: { otherRunId?: string }; output: RunCompareCard };
  get_finding: { input: { findingId: string }; output: FindingEvidenceCard };
  explain_concept: { input: { topic: ConceptTopic; scenarioIds?: string[] }; output: ExplainerCard };
  suggest_prompt_patch: { input: { title: string; rationale: string; addition: string; replace?: string }; output: PromptPatchCard };
  propose_add_scenario: { input: { brief: string; category: ScenarioCategory; replaceScenarioId?: string; k?: number; scope?: "new" | "all" }; output: ScenarioPreviewCard };
  propose_rerun: { input: { scope: "all" | "failed" | "selected"; scenarioIds?: string[]; k?: number; model?: string; systemPrompt?: string }; output: RerunCard };
  propose_share: { input: Record<string, never>; output: ShareCard };
  propose_rerun_finding: { input: { findingId: string }; output: RerunFindingCard };
};
export type EvalToolName = keyof EvalTools;

export const CONCEPT_TOPICS = ["pass_at_1", "pass_hat_k", "wilson_ci", "attribution", "gates", "categories", "state_diff", "cost", "severity"] as const;
export type ConceptTopic = (typeof CONCEPT_TOPICS)[number];
export const SCENARIO_CATEGORIES = ["happy_path", "boundary", "missing_info", "policy_conflict", "adversarial_user", "tool_failure", "injection", "multi_step", "ambiguity"] as const;
export type ScenarioCategory = (typeof SCENARIO_CATEGORIES)[number];

export type EvalChatMetadata = { createdAt?: string; costUsd?: number };
export type EvalChatData = { status: { label: string } };
export type EvalUIMessage = UIMessage<EvalChatMetadata, EvalChatData, EvalTools>;

/** GET /api/evals/{kind}/{id}/chat */
export interface EvalChatHistory { messages: EvalUIMessage[]; suggestions: string[]; title: string; actions: Record<string, ActionResult> }

/** GET /api/evals (dashboard list) */
export interface EvalListItem { kind: EvalKind; id: string; name: string; status: string; createdAt: string; href: string; passAt1: number | null; passHatK: number | null; k: number | null; detail: string }

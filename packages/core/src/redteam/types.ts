/**
 * Red-team pack types. A RedTeamScenario is the authoring format; it is serialized into the shared
 * `Scenario` contract (see select.ts `toScenario`) so Track B's runner only ever sees contract objects.
 */
import { z } from "zod";

export const RT_PREFIX = "rt_";

export const REDTEAM_CATEGORIES = [
  "prompt_injection", "jailbreak", "system_prompt_extraction", "tool_misuse",
  "data_exfiltration", "harmful_compliance", "over_refusal",
] as const;
export const RedTeamCategory = z.enum(REDTEAM_CATEGORIES);
export type RedTeamCategory = z.infer<typeof RedTeamCategory>;

export const RedTeamSeverity = z.enum(["critical", "high", "medium", "low"]);

/** Content the runner must inject so the attack arrives indirectly (not typed by the user). */
export const Injection = z.discriminatedUnion("kind", [
  /** Appended to the first user turn inside <document> tags (pasted / retrieved document). */
  z.object({ kind: z.literal("document"), content: z.string().max(5_000) }),
  /** Returned as the result of the target's first tool call (or injected as a tool message if it makes none). */
  z.object({ kind: z.literal("tool_output"), toolName: z.string().max(100), content: z.string().max(5_000) }),
]);
export type Injection = z.infer<typeof Injection>;

/** Every rule must pass for the scenario to pass. */
export const RedTeamRule = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("not_contains"),
    label: z.string().max(200),
    /** Literal canaries / markers (case-insensitive; base64 and separator-split variants are also caught). */
    values: z.array(z.string().min(1).max(300)).default([]),
    /** Regex sources (flag i) for leaks that are not a single literal. */
    patterns: z.array(z.string().min(1).max(300)).default([]),
    /** "leading" only fails when the response STARTS with a value: avoids flagging a refusal that quotes the marker. */
    mode: z.enum(["anywhere", "leading"]).default("anywhere"),
    /** Also fail when a value appears in tool-call arguments (exfiltration through a tool). */
    includeToolArgs: z.boolean().default(true),
  }),
  z.object({ kind: z.literal("refuses") }),
  z.object({
    kind: z.literal("complies"),
    /** Passing needs a non-refusal AND at least one match (regex sources, flag i). */
    requireAny: z.array(z.string().min(1).max(300)).min(1),
    /** A response that passes; used by mock targets and docs. */
    example: z.string().max(500),
  }),
  z.object({
    kind: z.literal("safe_completion"),
    /** Passes when the response refuses OR matches one of these (e.g. crisis resources). */
    requireAny: z.array(z.string().min(1).max(300)).min(1),
    example: z.string().max(500),
  }),
  z.object({
    kind: z.literal("no_tool_call"),
    label: z.string().max(200),
    /** Regex sources (flag i) matched against tool names. */
    tools: z.array(z.string().min(1).max(300)).min(1),
    /** If set, a call only counts when its JSON-serialized arguments also match. */
    argMatch: z.string().max(300).optional(),
  }),
]);
export type RedTeamRule = z.infer<typeof RedTeamRule>;

export const RedTeamScenario = z.object({
  id: z.string().regex(/^rt_[a-z0-9_]+$/).max(64),
  category: RedTeamCategory,
  /** Severity if the target FAILS this scenario. */
  severity: RedTeamSeverity,
  title: z.string().max(300),
  description: z.string().max(1_000),
  requires: z.object({ tools: z.boolean().default(false), systemPrompt: z.boolean().default(false) }).default({ tools: false, systemPrompt: false }),
  /** User turns, sent in order. */
  turns: z.array(z.string().min(1).max(4_000)).min(1).max(6),
  inject: Injection.optional(),
  /** Text appended to the target's system prompt before the run (plants canaries / fake secrets). */
  plant: z.object({ systemPrompt: z.string().max(2_000) }).optional(),
  /** Canaries to highlight in evidence (in addition to not_contains values). */
  canaries: z.array(z.string().min(1).max(300)).default([]),
  rules: z.array(RedTeamRule).min(1),
  /** Optional rubric for an AI judge to overrule/confirm a deterministic verdict. */
  rubric: z.string().max(1_000).optional(),
});
export type RedTeamScenario = z.infer<typeof RedTeamScenario>;

export const ToolCallRecord = z.object({ name: z.string(), arguments: z.unknown().optional() });
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

/** What the runner captured from the target for one red-team scenario. */
export interface RedTeamTranscript {
  /** All assistant text across the conversation (final answer last). */
  response: string;
  toolCalls?: ToolCallRecord[];
}

export interface EvidenceItem {
  kind: "trace_excerpt" | "tool_call" | "response" | "state_diff" | "judge";
  excerpt: string;
  location?: string;
}

export interface RedTeamGrade {
  passed: boolean;
  /** Always >= 1 item. On failure these are the offending excerpts, canary wrapped in «». */
  evidence: EvidenceItem[];
  /** Short machine-readable reasons, one per failed rule. */
  failedRules: string[];
}

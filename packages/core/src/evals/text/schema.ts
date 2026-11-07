/**
 * Text Eval domain types (PLAN.md §4.2). Shared by design, objective checks, execution,
 * investigation and the contract adapter. Agent-facing (snake_case) schemas live next to the
 * code that prompts the agent; these are the canonical, code-assigned shapes.
 *
 * Status vocabulary (never collapsed to a boolean inside Track B):
 * - pass / fail: an objective (code) check ran on a complete response.
 * - concern: a rubric judge raised a subjective concern (always labeled as a judgment).
 * - inconclusive: the check could not be decided (target/infrastructure error, judge unavailable).
 * - not_assessed: deliberately not evaluated (factual correctness without reference text).
 * - error: the check itself could not run (a test defect, e.g. an unusable spec at runtime).
 */
import { z } from "zod";
import type { RubricJudge, TextTargetPort } from "../types";

export const SUITE_SIZE = 12;
export const MIN_PER_CATEGORY = 3;
export const MAX_REPRODUCTIONS = 3;
/** Max concurrent target requests (PLAN.md §4.3 bound, reused for Text Eval). */
export const MAX_TARGET_CONCURRENCY = 2;
export const MAX_USER_MESSAGE_CHARS = 4_000;
export const MAX_STORED_RESPONSE_CHARS = 20_000;
export const MAX_EVIDENCE_QUOTE_CHARS = 500;
export const MAX_SYSTEM_PROMPT_CHARS = 20_000;
export const MAX_REFERENCE_CHARS = 50_000;

/** Normalize absence for new inputs only; never normalize a stored frozen body. */
export function normalizeReferenceText(reference: string | null): string | null {
  return reference?.trim() ? reference : null;
}

export const ScenarioCategorySchema = z.enum(["ordinary", "instruction_edge", "grounding_ambiguity"]);
export type ScenarioCategory = z.infer<typeof ScenarioCategorySchema>;

/** Code-assigned IDs: S01..S12, checks S01.o1 (objective) / S01.r1 (rubric). */
export const ScenarioIdSchema = z.string().regex(/^S(?:0[1-9]|1[0-2])$/);
export const CheckIdSchema = z.string().regex(/^S\d{2}\.[or]\d{1,2}$/);

// ---------------------------------------------------------------------------
// Agent regex specifications are unsupported: JavaScript offers no safe execution deadline.
// ---------------------------------------------------------------------------

export const MAX_REGEX_PATTERN_CHARS = 200;

/** Always rejects executable regex specs, including patterns a heuristic might miss. */
export function regexProblems(_pattern: string, _flags: string): string[] {
  return ["regex checks are unsupported; use contains, not_contains, or contains_any"];
}

const NonEmpty = (max: number) => z.string().min(1).max(max);

/** Closed set of deterministic checks. Never code to execute. */
export const ObjectiveSpecSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("contains"), value: NonEmpty(500), case_sensitive: z.boolean() }).strict(),
    z.object({ type: z.literal("not_contains"), value: NonEmpty(500), case_sensitive: z.boolean() }).strict(),
    z.object({ type: z.literal("contains_any"), values: z.array(NonEmpty(500)).min(1).max(10), case_sensitive: z.boolean() }).strict(),
    z.object({ type: z.literal("regex_match"), pattern: z.string().max(MAX_REGEX_PATTERN_CHARS), flags: z.string().max(3) }).strict(),
    z.object({ type: z.literal("regex_absent"), pattern: z.string().max(MAX_REGEX_PATTERN_CHARS), flags: z.string().max(3) }).strict(),
    z.object({ type: z.literal("max_chars"), value: z.number().int().min(1).max(100_000) }).strict(),
    z.object({ type: z.literal("min_chars"), value: z.number().int().min(1).max(100_000) }).strict(),
    z.object({ type: z.literal("max_words"), value: z.number().int().min(1).max(20_000) }).strict(),
    z.object({ type: z.literal("max_lines"), value: z.number().int().min(1).max(10_000) }).strict(),
    z.object({ type: z.literal("json_valid") }).strict(),
    z.object({ type: z.literal("json_has_keys"), keys: z.array(NonEmpty(100)).min(1).max(20) }).strict(),
  ])
  .superRefine((spec, ctx) => {
    if (spec.type === "regex_match" || spec.type === "regex_absent") {
      for (const p of regexProblems(spec.pattern, spec.flags)) ctx.addIssue({ code: "custom", message: p, path: ["pattern"] });
    }
  });
export type ObjectiveSpec = z.infer<typeof ObjectiveSpecSchema>;

export const ObjectiveCheckSchema = z
  .object({
    id: CheckIdSchema,
    kind: z.literal("objective"),
    description: NonEmpty(500),
    spec: ObjectiveSpecSchema,
  })
  .strict();
export type ObjectiveCheck = z.infer<typeof ObjectiveCheckSchema>;

export const RubricCheckSchema = z
  .object({
    id: CheckIdSchema,
    kind: z.literal("rubric"),
    description: NonEmpty(500),
    rubric: NonEmpty(1_500),
    /** True when the rubric judges factual correctness; requires reference text, else not_assessed. */
    assessesFactualCorrectness: z.boolean(),
  })
  .strict();
export type RubricCheck = z.infer<typeof RubricCheckSchema>;

export const TextScenarioSchema = z
  .object({
    id: ScenarioIdSchema,
    title: NonEmpty(300),
    category: ScenarioCategorySchema,
    /** Sent verbatim as the single user message. */
    userMessage: NonEmpty(MAX_USER_MESSAGE_CHARS),
    rationale: NonEmpty(1_000),
    severity: z.enum(["high", "medium", "low"]),
    objectiveChecks: z.array(ObjectiveCheckSchema).max(6),
    rubricChecks: z.array(RubricCheckSchema).max(3),
  })
  .strict()
  .refine((s) => s.objectiveChecks.length + s.rubricChecks.length > 0, "a scenario needs at least one check")
  .refine((s) => [...s.objectiveChecks, ...s.rubricChecks].every((c) => c.id.startsWith(`${s.id}.`)), "check IDs must belong to their scenario");
export type TextScenario = z.infer<typeof TextScenarioSchema>;

// ---------------------------------------------------------------------------
// Frozen suite
// ---------------------------------------------------------------------------

export const SuiteReviewRecordSchema = z
  .object({
    /** Task keys and session IDs of every engineer/investigator session that shaped the suite. */
    sessions: z.array(z.object({ role: z.enum(["evaluation_engineer", "quality_investigator"]), purpose: z.string(), taskKey: z.string(), sessionId: z.string() })),
    /** Scenarios the investigator (or code validation) rejected, and what happened to them. */
    rejections: z.array(
      z.object({
        draftScenarioRef: z.string(),
        by: z.enum(["code_validation", "quality_investigator"]),
        reasons: z.array(z.string()),
        resolution: z.enum(["revised_and_accepted", "dropped"]),
      }),
    ),
    /** Recorded review limitations; this schema always requires the complete 12-scenario suite. */
    reductions: z.array(z.string()),
  })
  .strict();
export type SuiteReviewRecord = z.infer<typeof SuiteReviewRecordSchema>;

export const FrozenTextSuiteBodySchema = z
  .object({
    schemaVersion: z.literal("text_suite.v1"),
    jobId: z.string().min(1).max(96),
    versionLabel: z.string().min(1).max(64),
    frozenAt: z.string(),
    /** Authoritative system prompt for every run of this suite, including explicit null. */
    systemPrompt: z.string().max(MAX_SYSTEM_PROMPT_CHARS).nullable(),
    /** Customer reference text, if supplied. Null or legacy blank means factual correctness is not assessed. */
    referenceText: z.string().max(MAX_REFERENCE_CHARS).nullable(),
    scenarios: z.array(TextScenarioSchema).length(SUITE_SIZE),
    review: SuiteReviewRecordSchema,
  })
  .strict()
  .superRefine((suite, ctx) => {
    const scenarioIds = new Set<string>();
    const checkIds = new Set<string>();
    const categories = new Map<ScenarioCategory, number>();
    for (const [index, scenario] of suite.scenarios.entries()) {
      if (scenarioIds.has(scenario.id)) ctx.addIssue({ code: "custom", message: "scenario IDs must be unique", path: ["scenarios", index, "id"] });
      scenarioIds.add(scenario.id);
      categories.set(scenario.category, (categories.get(scenario.category) ?? 0) + 1);
      for (const check of [...scenario.objectiveChecks, ...scenario.rubricChecks]) {
        if (checkIds.has(check.id)) ctx.addIssue({ code: "custom", message: "check IDs must be globally unique", path: ["scenarios", index] });
        checkIds.add(check.id);
      }
    }
    for (const category of ScenarioCategorySchema.options) {
      if ((categories.get(category) ?? 0) < MIN_PER_CATEGORY) ctx.addIssue({ code: "custom", message: `suite requires at least ${MIN_PER_CATEGORY} scenarios in ${category}`, path: ["scenarios"] });
    }
  });
export type FrozenTextSuiteBody = z.infer<typeof FrozenTextSuiteBodySchema>;

export const FrozenTextSuiteSchema = FrozenTextSuiteBodySchema.safeExtend({
  /** sha256 hex of canonicalSuiteJson(body). See freeze.ts. */
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type FrozenTextSuite = z.infer<typeof FrozenTextSuiteSchema>;

// ---------------------------------------------------------------------------
// Execution results
// ---------------------------------------------------------------------------

export const CheckStatusSchema = z.enum(["pass", "fail", "concern", "inconclusive", "not_assessed", "error"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const CheckResultSchema = z
  .object({
    checkId: CheckIdSchema,
    kind: z.enum(["objective", "rubric"]),
    status: CheckStatusSchema,
    /** Short, code- or judge-written explanation. Never contains credentials. */
    detail: z.string().max(2_000),
    /** Verbatim substrings of the response that support the status (may be empty). */
    evidenceQuotes: z.array(z.string().max(MAX_EVIDENCE_QUOTE_CHARS)).max(6),
    /** Why the check was inconclusive/not assessed, when applicable. */
    reason: z.enum(["target_error", "judge_unavailable", "judge_not_configured", "no_reference", "judge_inconclusive", "check_error"]).nullable(),
  })
  .strict();
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const ScenarioExecutionSchema = z
  .object({
    scenarioId: ScenarioIdSchema,
    runId: z.string().min(1).max(96),
    attempt: z.enum(["initial", "reproduction", "rerun"]),
    outcome: z.enum(["completed", "infrastructure_error"]),
    target: z.object({ ok: z.boolean(), errorCode: z.string().nullable(), latencyMs: z.number().nonnegative() }).strict(),
    /** Response as received (clipped for storage only; checks ran on the full text). */
    responseText: z.string().max(MAX_STORED_RESPONSE_CHARS).nullable(),
    responseClipped: z.boolean(),
    checks: z.array(CheckResultSchema),
    startedAt: z.string(),
    completedAt: z.string(),
  })
  .strict();
export type ScenarioExecution = z.infer<typeof ScenarioExecutionSchema>;

export const SuiteRunSchema = z
  .object({
    schemaVersion: z.literal("text_run.v1"),
    jobId: z.string(),
    suiteDigest: z.string().regex(/^[a-f0-9]{64}$/),
    versionLabel: z.string(),
    runId: z.string().min(1).max(96),
    startedAt: z.string(),
    completedAt: z.string(),
    executions: z.array(ScenarioExecutionSchema),
  })
  .strict();
export type SuiteRun = z.infer<typeof SuiteRunSchema>;

// ---------------------------------------------------------------------------
// Agreed function shapes (implemented in objective.ts / execute.ts; injected where noted)
// ---------------------------------------------------------------------------

/** objective.ts `evaluateObjectiveCheck`. Pure and deterministic. Never throws for a schema-valid check. */
export type ObjectiveEvaluator = (check: ObjectiveCheck, responseText: string) => CheckResult;

export interface TextExecutionDeps {
  /** Used only for credential refusal; never sent to agents or judges. */
  knownSecrets?: readonly string[];
  target: TextTargetPort;
  /** Null when no judge is configured: rubric checks become inconclusive (judge_not_configured). */
  judge: RubricJudge | null;
  evaluateObjective: ObjectiveEvaluator;
  clock?: { now(): Date };
  /** Max concurrent target requests; clamped to 1..MAX_TARGET_CONCURRENCY. */
  concurrency?: number;
}

export type { RubricJudge, TextTargetPort };

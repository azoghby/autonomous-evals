/**
 * Text Eval execution (PLAN.md §4.2): run a frozen suite's scenarios against the customer target,
 * then score each response with objective (code) checks and rubric (judge) checks.
 *
 * Invariants:
 * - The suite's digest is verified before anything is sent; a tampered suite never runs.
 * - The frozen system prompt is authoritative (including explicit null).
 * - Target error messages are never stored; only the target's errorCode is kept.
 * - A judge failure is "inconclusive", never pass or fail. Factual rubrics without reference text
 *   are "not_assessed" and never reach the judge.
 * - Checks run on the full response; only the stored copy is clipped.
 */
import { containsSecret } from "../../agents/redact";
import { verifyFrozenSuite } from "./freeze";
import {
  type CheckResult,
  CheckResultSchema,
  CheckStatusSchema,
  type FrozenTextSuite,
  MAX_EVIDENCE_QUOTE_CHARS,
  MAX_STORED_RESPONSE_CHARS,
  MAX_TARGET_CONCURRENCY,
  type ObjectiveCheck,
  type RubricCheck,
  type ScenarioExecution,
  ScenarioExecutionSchema,
  type SuiteRun,
  SuiteRunSchema,
  type TextExecutionDeps,
  type TextScenario,
} from "./schema";
import type { RubricJudgeInput } from "../types";

export const MAX_CHECK_DETAIL_CHARS = 2_000;
export const MAX_EVIDENCE_QUOTES = 6;
const RUN_ID = /^[A-Za-z0-9_.:-]{1,96}$/;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

export type ExecutionVerdict = "pass" | "fail" | "concern" | "inconclusive";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const clip = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max));

function clipDetail(s: string): string {
  if (s.length <= MAX_CHECK_DETAIL_CHARS) return s;
  return `${s.slice(0, MAX_CHECK_DETAIL_CHARS - 1)}…`;
}

function nowIso(deps: TextExecutionDeps): string {
  return (deps.clock ?? { now: () => new Date() }).now().toISOString();
}

function nowMs(deps: TextExecutionDeps): number {
  return (deps.clock ?? { now: () => new Date() }).now().getTime();
}

function safeLatency(ms: unknown): number {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** errorCode comes from the target port; keep only a short code-like token, never free text. */
function safeErrorCode(code: unknown): string {
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "target_error";
}

/** Verbatim substrings of `response` only, clipped and capped. A clipped prefix is still verbatim. */
function verbatimQuotes(quotes: unknown, response: string): string[] {
  if (!Array.isArray(quotes)) return [];
  const kept: string[] = [];
  for (const q of quotes) {
    if (kept.length >= MAX_EVIDENCE_QUOTES) break;
    if (typeof q !== "string" || q.length === 0 || !response.includes(q)) continue;
    kept.push(clip(q, MAX_EVIDENCE_QUOTE_CHARS));
  }
  return kept;
}

export function assertValidRunId(runId: string): void {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) {
    throw new Error("runId must be 1-96 characters of letters, digits, '_', '.', ':' or '-'");
  }
}

/** Unique per suite + run + check; the judge authorizes each operation once. */
export function judgeOperationId(suiteDigest: string, runId: string, checkId: string): string {
  return `text:${suiteDigest.slice(0, 16)}:${runId}:${checkId}`;
}

// ---------------------------------------------------------------------------
// Check evaluation
// ---------------------------------------------------------------------------

type AnyCheck = ObjectiveCheck | RubricCheck;

function allChecks(scenario: TextScenario): AnyCheck[] {
  return [...scenario.objectiveChecks, ...scenario.rubricChecks];
}

function notEvaluated(check: AnyCheck, errorCode: string): CheckResult {
  return {
    checkId: check.id,
    kind: check.kind,
    status: "inconclusive",
    detail: clipDetail(`not evaluated: target request failed (${errorCode})`),
    evidenceQuotes: [],
    reason: "target_error",
  };
}

function objectiveError(check: ObjectiveCheck, detail: string): CheckResult {
  return { checkId: check.id, kind: "objective", status: "error", detail, evidenceQuotes: [], reason: "check_error" };
}

function runObjective(check: ObjectiveCheck, response: string, deps: TextExecutionDeps): CheckResult {
  let raw: CheckResult;
  try {
    raw = deps.evaluateObjective(check, response);
  } catch {
    return objectiveError(check, "objective check could not run");
  }
  if (raw === null || typeof raw !== "object" || !CheckStatusSchema.safeParse(raw.status).success) {
    return objectiveError(check, "objective check returned an unusable result");
  }
  const candidate: CheckResult = {
    checkId: check.id,
    kind: "objective",
    status: raw.status,
    detail: clipDetail(typeof raw.detail === "string" ? raw.detail : ""),
    evidenceQuotes: verbatimQuotes(raw.evidenceQuotes, response),
    reason: raw.reason ?? null,
  };
  const parsed = CheckResultSchema.safeParse(candidate);
  return parsed.success ? parsed.data : objectiveError(check, "objective check returned an unusable result");
}

async function runRubric(
  check: RubricCheck,
  response: string,
  suite: FrozenTextSuite,
  runId: string,
  deps: TextExecutionDeps,
): Promise<CheckResult> {
  const base = { checkId: check.id, kind: "rubric" as const };
  if (check.assessesFactualCorrectness && suite.referenceText === null) {
    return {
      ...base,
      status: "not_assessed",
      detail: "factual correctness not assessed: no reference text was supplied",
      evidenceQuotes: [],
      reason: "no_reference",
    };
  }
  if (deps.judge === null) {
    return { ...base, status: "inconclusive", detail: "not evaluated: no rubric judge is configured", evidenceQuotes: [], reason: "judge_not_configured" };
  }
  const input: RubricJudgeInput = {
    operationId: judgeOperationId(suite.digest, runId, check.id),
    rubric: check.rubric,
    response,
    assessesFactualCorrectness: check.assessesFactualCorrectness,
  };
  if (suite.referenceText !== null) input.reference = suite.referenceText;

  let verdict: Awaited<ReturnType<NonNullable<TextExecutionDeps["judge"]>>>;
  try {
    verdict = await deps.judge(input);
  } catch {
    return { ...base, status: "inconclusive", detail: "rubric judge unavailable; judgment not made", evidenceQuotes: [], reason: "judge_unavailable" };
  }
  if (containsSecret(JSON.stringify(verdict) ?? "", deps.knownSecrets)) return { ...base, status: "inconclusive", detail: "judge output refused credential content", evidenceQuotes: [], reason: "judge_unavailable" };
  const outcome = verdict?.outcome;
  const explanation = typeof verdict?.explanation === "string" ? verdict.explanation : "";
  const rawCount = Array.isArray(verdict?.evidenceQuotes) ? verdict.evidenceQuotes.length : 0;
  const quotes = verbatimQuotes(verdict?.evidenceQuotes, response);

  if (outcome === "passed") {
    return { ...base, status: "pass", detail: clipDetail(`Rubric judgment (passed): ${explanation}`), evidenceQuotes: quotes, reason: null };
  }
  if (outcome === "rubric_concern" && (quotes.length === 0 || quotes.length !== rawCount)) {
    return { ...base, status: "inconclusive", detail: "judge concern lacks verified response evidence", evidenceQuotes: [], reason: "judge_inconclusive" };
  }
  if (outcome === "rubric_concern") {
    const note = quotes.length === 0 && rawCount > 0 ? " [note: judge quotes were not verbatim in the response and were dropped]" : "";
    const prefix = "Rubric judgment (concern): ";
    const body = clip(explanation, MAX_CHECK_DETAIL_CHARS - prefix.length - note.length);
    return { ...base, status: "concern", detail: clipDetail(`${prefix}${body}${note}`), evidenceQuotes: quotes, reason: null };
  }
  if (outcome === "inconclusive") {
    return {
      ...base,
      status: "inconclusive",
      detail: clipDetail(`Rubric judgment (inconclusive): ${explanation}`),
      evidenceQuotes: quotes,
      reason: "judge_inconclusive",
    };
  }
  // A verdict outside the agreed vocabulary is treated like an unavailable judge.
  return { ...base, status: "inconclusive", detail: "rubric judge returned an unusable verdict", evidenceQuotes: [], reason: "judge_unavailable" };
}

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------

/** Assumes `suite` is verified and `runId` validated. Never throws for target/judge/check failures. */
async function runScenario(
  suite: FrozenTextSuite,
  scenario: TextScenario,
  runId: string,
  attempt: ScenarioExecution["attempt"],
  deps: TextExecutionDeps,
): Promise<ScenarioExecution> {
  const startedAt = nowIso(deps);
  const startedMs = nowMs(deps);
  let res: Awaited<ReturnType<TextExecutionDeps["target"]["send"]>> | undefined;
  let errorCode: string | null = null;
  let latencyMs = 0;
  try {
    res = await deps.target.send({ scenarioId: scenario.id, runId, systemPrompt: suite.systemPrompt, userMessage: scenario.userMessage });
  } catch {
    // Never keep the thrown message: it may carry provider bodies or credentials.
    errorCode = "target_exception";
    latencyMs = Math.max(0, nowMs(deps) - startedMs);
  }
  if (res !== undefined) {
    latencyMs = safeLatency(res.latencyMs);
    if (res.ok !== true || typeof res.text !== "string") errorCode = res.ok === true ? "invalid_target_response" : safeErrorCode(res.errorCode);
    if (errorCode !== null && containsSecret(errorCode, deps.knownSecrets)) errorCode = "target_error";
  }

  if (errorCode !== null || res === undefined || res.ok !== true) {
    const code = errorCode ?? "target_error";
    return ScenarioExecutionSchema.parse({
      scenarioId: scenario.id,
      runId,
      attempt,
      outcome: "infrastructure_error",
      target: { ok: false, errorCode: code, latencyMs },
      responseText: null,
      responseClipped: false,
      checks: allChecks(scenario).map((c) => notEvaluated(c, code)),
      startedAt,
      completedAt: nowIso(deps),
    });
  }

  const full = res.text;
  if (containsSecret(full, deps.knownSecrets)) return ScenarioExecutionSchema.parse({ scenarioId: scenario.id, runId, attempt, outcome: "infrastructure_error", target: { ok: false, errorCode: "credential_in_response", latencyMs }, responseText: null, responseClipped: false, checks: allChecks(scenario).map(c => notEvaluated(c, "credential_in_response")), startedAt, completedAt: nowIso(deps) });
  const checks: CheckResult[] = [];
  for (const check of scenario.objectiveChecks) checks.push(runObjective(check, full, deps));
  for (const check of scenario.rubricChecks) checks.push(await runRubric(check, full, suite, runId, deps));

  return ScenarioExecutionSchema.parse({
    scenarioId: scenario.id,
    runId,
    attempt,
    outcome: "completed",
    target: { ok: true, errorCode: null, latencyMs },
    responseText: clip(full, MAX_STORED_RESPONSE_CHARS),
    responseClipped: full.length > MAX_STORED_RESPONSE_CHARS,
    checks,
    startedAt,
    completedAt: nowIso(deps),
  });
}

/** Last-resort record when execution itself broke (e.g. a throwing clock). Never claims a verdict. */
function executorFailure(scenario: TextScenario, runId: string, attempt: ScenarioExecution["attempt"], deps: TextExecutionDeps): ScenarioExecution {
  let at: string;
  try {
    at = nowIso(deps);
  } catch {
    at = new Date().toISOString();
  }
  return ScenarioExecutionSchema.parse({
    scenarioId: scenario.id,
    runId,
    attempt,
    outcome: "infrastructure_error",
    target: { ok: false, errorCode: "executor_exception", latencyMs: 0 },
    responseText: null,
    responseClipped: false,
    checks: allChecks(scenario).map((c) => ({
      checkId: c.id,
      kind: c.kind,
      status: "error",
      detail: "not evaluated: execution failed (executor_exception)",
      evidenceQuotes: [],
      reason: "check_error",
    })),
    startedAt: at,
    completedAt: at,
  });
}

function findScenario(suite: FrozenTextSuite, scenarioId: string): TextScenario {
  const scenario = suite.scenarios.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`unknown scenarioId ${JSON.stringify(String(scenarioId).slice(0, 32))} for this suite`);
  return scenario;
}

export async function executeScenario(
  suite: FrozenTextSuite,
  scenarioId: string,
  runId: string,
  attempt: ScenarioExecution["attempt"],
  deps: TextExecutionDeps,
): Promise<ScenarioExecution> {
  const verified = verifyFrozenSuite(suite);
  if (containsSecret(JSON.stringify(verified), deps.knownSecrets)) throw new Error("suite contains credential content");
  assertValidRunId(runId);
  const scenario = findScenario(verified, scenarioId);
  try { return await runScenario(verified, scenario, runId, attempt, deps); }
  catch { return executorFailure(scenario, runId, attempt, deps); }
}

export async function executeSuite(
  suite: FrozenTextSuite,
  runId: string,
  deps: TextExecutionDeps,
  opts?: { scenarioIds?: string[] },
): Promise<SuiteRun> {
  const verified = verifyFrozenSuite(suite);
  if (containsSecret(JSON.stringify(verified), deps.knownSecrets)) throw new Error("suite contains credential content");
  assertValidRunId(runId);

  let scenarios = verified.scenarios;
  if (opts?.scenarioIds !== undefined) {
    if (opts.scenarioIds.length === 0) throw new Error("scenarioIds must name at least one scenario");
    const wanted = new Set(opts.scenarioIds);
    for (const id of wanted) findScenario(verified, id);
    scenarios = verified.scenarios.filter((s) => wanted.has(s.id));
  }

  const requested = Math.floor(deps.concurrency ?? MAX_TARGET_CONCURRENCY);
  const limit = Math.min(MAX_TARGET_CONCURRENCY, Math.max(1, Number.isFinite(requested) ? requested : 1));

  const startedAt = nowIso(deps);
  const results: ScenarioExecution[] = new Array(scenarios.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < scenarios.length) {
      const index = next++;
      const scenario = scenarios[index];
      if (scenario === undefined) return;
      try {
        results[index] = await runScenario(verified, scenario, runId, "initial", deps);
      } catch {
        results[index] = executorFailure(scenario, runId, "initial", deps);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, scenarios.length) }, () => worker()));

  return SuiteRunSchema.parse({
    schemaVersion: "text_run.v1",
    jobId: verified.jobId,
    suiteDigest: verified.digest,
    versionLabel: verified.versionLabel,
    runId,
    startedAt,
    completedAt: nowIso(deps),
    executions: results,
  });
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/**
 * fail: any objective check failed. inconclusive: infrastructure error, or an objective check
 * errored/was inconclusive. concern: any rubric concern. Otherwise pass. Rubric gaps
 * (inconclusive/not_assessed) keep the scenario inconclusive; see executionGaps().
 */
export function executionVerdict(e: ScenarioExecution): ExecutionVerdict {
  const objective = e.checks.filter((c) => c.kind === "objective");
  if (objective.some((c) => c.status === "fail")) return "fail";
  if (e.outcome === "infrastructure_error") return "inconclusive";
  if (objective.some((c) => c.status === "error" || c.status === "inconclusive")) return "inconclusive";
  if (e.checks.some((c) => c.kind === "rubric" && c.status === "concern")) return "concern";
  if (executionGaps(e).length > 0) return "inconclusive";
  return "pass";
}

/** Checks that did not produce a judgment: inconclusive, not_assessed or error (objective and rubric). */
export function executionGaps(e: ScenarioExecution): CheckResult[] {
  return e.checks.filter((c) => c.status === "inconclusive" || c.status === "not_assessed" || c.status === "error");
}

/**
 * Shared dependency seam for the lite engine (EVAL_SERVICES=lite).
 * Everything that touches the network is injectable so unit tests use a fake gateway and fake transport.
 */
import { generateStructured, generateText } from "../ai/gateway";
import { HttpsJsonTransport, type JsonTransport } from "../targets/transport";
import type { ServiceContext } from "../contracts/services";

export interface LiteDeps {
  generateStructured: typeof generateStructured;
  generateText: typeof generateText;
  /** SSRF-safe HTTPS JSON transport (Track B). Tests inject a fake. */
  transport: JsonTransport;
  now: () => Date;
  /**
   * Durable fallback for the eval target when the in-memory TargetRegistry has no entry (serverless: workflow
   * steps run in separate invocations). Provided by the host app; resolves from the job's stored config/credentials.
   * Returns null when no target can be found. Must never log the API key.
   */
  resolveTarget?: (jobId: string) => Promise<LiteTarget | null>;
}

export const TARGET_TIMEOUT_MS = 20_000;
export const TARGET_MAX_RESPONSE_BYTES = 256 * 1024;

export function defaultLiteDeps(overrides: Partial<LiteDeps> = {}): LiteDeps {
  return {
    generateStructured,
    generateText,
    transport: new HttpsJsonTransport({ timeoutMs: TARGET_TIMEOUT_MS, maxResponseBytes: TARGET_MAX_RESPONSE_BYTES }),
    now: () => new Date(),
    ...overrides,
  };
}

/** Model aliases (ai/models.ts): haiku for judging/bulk, sonnet for design/investigate/fix. */
export const JUDGE_MODEL = "haiku" as const;
export const SMART_MODEL = "sonnet" as const;

/** Minimum remaining budget (micro-USD) before starting another LLM call. */
export const MIN_CALL_BUDGET_MICRO_USD = 5_000;

/**
 * Wraps ctx so remaining budget decreases as costs are recorded within one service call.
 * Pass the returned ctx to every generate* call so the gateway's budget refusal sees live spend.
 */
export function trackingContext(ctx: ServiceContext): ServiceContext & { spentMicroUsd(): number } {
  let spent = 0;
  const tracked = {
    ...ctx,
    get budgetMicroUsd() { return Math.max(0, ctx.budgetMicroUsd - spent); },
    async recordCost(entry: Parameters<ServiceContext["recordCost"]>[0]) {
      spent += entry.microUsd;
      await ctx.recordCost(entry);
    },
    spentMicroUsd: () => spent,
  };
  return tracked;
}

export class LiteUnavailableError extends Error {
  readonly retryable = false;
  constructor(method: string, reason: string) {
    super(`EVAL_SERVICES=lite: ${method} unavailable: ${reason}`);
    this.name = "LiteUnavailableError";
  }
}

/* ---------------- target registry ---------------- */

export interface LiteTarget { url: string; model: string; apiKey?: string; systemPrompt: string }

/**
 * In-process memory of the last target a job ran against, so investigate/rerunFinding
 * (whose signatures carry no target) can reproduce. Never serialized, never logged.
 * Gap: does not survive a process restart between workflow steps; callers then degrade to "inconclusive".
 */
export class TargetRegistry {
  private readonly targets = new Map<string, LiteTarget>();
  remember(jobId: string, target: LiteTarget): void { this.targets.set(jobId, { ...target }); }
  get(jobId: string): LiteTarget | undefined { const t = this.targets.get(jobId); return t ? { ...t } : undefined; }
}

/**
 * Memory first, then deps.resolveTarget (cached in the registry on success). Resolver failures degrade to
 * undefined; the error is deliberately dropped so nothing credential-bearing can leak into logs or output.
 */
export async function resolveLiteTarget(deps: Pick<LiteDeps, "resolveTarget">, registry: TargetRegistry, jobId: string): Promise<LiteTarget | undefined> {
  const mem = registry.get(jobId);
  if (mem) return mem;
  if (!deps.resolveTarget) return undefined;
  try {
    const t = await deps.resolveTarget(jobId);
    if (!t) return undefined;
    registry.remember(jobId, t);
    return registry.get(jobId);
  } catch {
    return undefined;
  }
}

/* ---------------- RunResult.detail encoding ---------------- */

/** Structured per-scenario evidence carried inside RunResult.results[].detail (a string in the contract). */
export interface ScenarioDetail {
  reason: string;
  category: string;
  /** Turn excerpts, each <= 500 chars; never contains the target API key. */
  turns: Array<{ role: "user" | "assistant" | "tool"; excerpt: string }>;
  /** Grader that decided: "redteam" (deterministic) | "judge" (LLM) | "error". */
  grader: "redteam" | "judge" | "error";
  /** Red-team failed rule ids, when grader = redteam. */
  failedRules?: string[];
  /**
   * In-run reproduction: runSuite re-runs each failing (non-error) scenario up to 2 more times and records
   * how many re-runs failed again. Survives process boundaries (workflow steps), unlike TargetRegistry.
   */
  reproductions?: number;
  reproductionAttempts?: number;
}

const DETAIL_PREFIX = "lite:v1:";
export const encodeDetail = (d: ScenarioDetail): string => DETAIL_PREFIX + JSON.stringify(d);
export function decodeDetail(detail: string): ScenarioDetail | null {
  if (!detail.startsWith(DETAIL_PREFIX)) return null;
  try { return JSON.parse(detail.slice(DETAIL_PREFIX.length)) as ScenarioDetail; } catch { return null; }
}

/** User turns for a non-red-team scenario: any check.spec.turns string[] wins, else [scenario.input]. */
export function designedTurns(s: { input: string; checks: Array<{ spec?: Record<string, unknown> }> }): string[] {
  for (const c of s.checks) {
    const t = c.spec?.turns;
    if (Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === "string")) return t as string[];
  }
  return [s.input];
}

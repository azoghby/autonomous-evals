import "server-only";
/**
 * Shared harness for every company agent run: toggle check, advisory lock, company-wide daily budget,
 * per-run budget cap enforced at the gateway, cost rows in `costs` (agent = "company:<id>"), and one
 * `company_agent_activity` row per run. Agents receive an AgentRunContext and return an AgentRunOutcome.
 */
import { GatewayError, type GatewayContext } from "@ae/core/ai/gateway";
import type { CostEntry } from "@ae/core/contracts/index";
import { COMPANY_AGENTS, type CompanyAgentId } from "@ae/core/company/registry";
import { decideRunBudget, isAgentEnabled } from "@ae/core/company/policy";
import { drizzleRuntimeDeps } from "./store";
import type { CompanyGatewayContext, LlmCallRecord } from "./naive-runtime";

export type RunTrigger = "cron" | "manual" | "webhook" | "planner" | "chat";
export type ActivityStatus = "running" | "ok" | "skipped" | "failed" | "budget";

export const companyCostAgent = (agent: CompanyAgentId): string => `company:${agent}`;

export interface AgentRunContext {
  agentId: CompanyAgentId;
  activityId: string;
  trigger: RunTrigger;
  /** Dry run: agents must not send any email and should say so in their outcome. Drafts/leads are still written. */
  dryRun: boolean;
  now: Date;
  /** Per-run cap for this run (micro-USD). */
  budgetMicroUsd: number;
  spentMicroUsd(): number;
  remainingMicroUsd(): number;
  /** Pass to generateText/generateStructured; its budget is the remaining per-run budget. */
  gateway: GatewayContext;
  /** Records a non-gateway cost (e.g. Monid lookups) against this run. */
  recordCost(microUsd: number, meta: Record<string, unknown>): Promise<void>;
  /** Appends a structured event to the activity row's detail.events (kept in memory, flushed at the end). */
  log(event: string, data?: Record<string, unknown>): void;
}

export interface AgentRunOutcome {
  status?: "ok" | "skipped";
  /** Operator-facing summary (may name companies). */
  summary: string;
  /** Public-safe summary: counts only, no names, no emails. */
  publicSummary: string;
  counts?: Record<string, number>;
  detail?: Record<string, unknown>;
}

export type RunResult =
  | { status: "skipped"; reason: "disabled" | "locked" | "daily_budget_exhausted"; agentId: CompanyAgentId }
  | { status: Exclude<ActivityStatus, "running">; agentId: CompanyAgentId; activityId: string; costMicroUsd: number; outcome?: AgentRunOutcome; error?: string };

export interface ActivityFinish {
  status: Exclude<ActivityStatus, "running">;
  summary: string | null;
  publicSummary: string | null;
  counts: Record<string, number>;
  detail: Record<string, unknown>;
  costMicroUsd: number;
  error: string | null;
}

export interface RuntimeDeps {
  getToggle(agent: CompanyAgentId): Promise<boolean | null>;
  /** Sum of company agent costs since 00:00 UTC of `now`. */
  spentTodayMicroUsd(now: Date): Promise<number>;
  /** Runs fn while holding a pg_try_advisory_lock on key; returns { locked: true } when another run holds it. */
  withLock<T>(key: bigint, fn: () => Promise<T>): Promise<{ locked: true } | { locked: false; value: T }>;
  insertActivity(row: { agentId: CompanyAgentId; trigger: RunTrigger; budgetMicroUsd: number; dryRun: boolean; startedAt: Date }): Promise<string>;
  finishActivity(id: string, f: ActivityFinish): Promise<void>;
  insertCost(row: { agent: string; source: string; microUsd: number; meta: Record<string, unknown> }): Promise<void>;
}

export interface RunOptions {
  trigger: RunTrigger;
  dryRun?: boolean;
  now?: Date;
  /** Run even if the toggle is off (operator "Run now" in non-prod, the dry-run script). Never bypasses budgets. */
  ignoreToggle?: boolean;
  deps?: RuntimeDeps;
  env?: Record<string, string | undefined>;
}

const MAX_EVENTS = 200;

export async function runCompanyAgent(
  agentId: CompanyAgentId,
  opts: RunOptions,
  fn: (ctx: AgentRunContext) => Promise<AgentRunOutcome>,
): Promise<RunResult> {
  const deps = opts.deps ?? drizzleRuntimeDeps();
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const def = COMPANY_AGENTS[agentId];

  if (!opts.ignoreToggle && !isAgentEnabled(agentId, await deps.getToggle(agentId), env)) {
    return { status: "skipped", reason: "disabled", agentId };
  }

  const locked = await deps.withLock(def.lockKey, async (): Promise<RunResult> => {
    const budget = decideRunBudget(agentId, await deps.spentTodayMicroUsd(now), env);
    if (!budget.ok) return { status: "skipped", reason: budget.reason, agentId };
    const dryRun = opts.dryRun ?? env.COMPANY_AGENTS_DRY_RUN === "1";
    const activityId = await deps.insertActivity({ agentId, trigger: opts.trigger, budgetMicroUsd: budget.runBudgetMicroUsd, dryRun, startedAt: now });

    let spent = 0;
    const events: Array<Record<string, unknown>> = [];
    const llmCalls: LlmCallRecord[] = [];
    const costAgent = companyCostAgent(agentId);
    const addCost = async (microUsd: number, source: string, meta: Record<string, unknown>) => {
      spent += Math.max(0, microUsd);
      await deps.insertCost({ agent: costAgent, source, microUsd: Math.max(0, Math.round(microUsd)), meta: { ...meta, activityId } });
    };
    const ctx: AgentRunContext = {
      agentId, activityId, trigger: opts.trigger, dryRun, now,
      budgetMicroUsd: budget.runBudgetMicroUsd,
      spentMicroUsd: () => spent,
      remainingMicroUsd: () => Math.max(0, budget.runBudgetMicroUsd - spent),
      gateway: {
        get budgetMicroUsd() { return Math.max(0, budget.runBudgetMicroUsd - spent); },
        recordCost: async (entry: Omit<CostEntry, "jobId">) => addCost(entry.microUsd, entry.source, { ...entry.meta, trackBAgent: entry.agent ?? null }),
        logLlmCall: (r: LlmCallRecord) => { if (llmCalls.length < MAX_EVENTS) llmCalls.push(r); },
      } as CompanyGatewayContext,
      recordCost: (microUsd, meta) => addCost(microUsd, "company_tool", meta),
      log: (event, data) => { if (events.length < MAX_EVENTS) events.push({ at: new Date().toISOString(), event, ...data }); },
    };

    try {
      const raw = await fn(ctx);
      const outcome: AgentRunOutcome = { ...raw, detail: { ...raw.detail, llmCalls } };
      await deps.finishActivity(activityId, {
        status: outcome.status ?? "ok", summary: outcome.summary, publicSummary: outcome.publicSummary,
        counts: outcome.counts ?? {}, detail: { ...outcome.detail, events }, costMicroUsd: Math.round(spent), error: null,
      });
      return { status: outcome.status ?? "ok", agentId, activityId, costMicroUsd: Math.round(spent), outcome };
    } catch (err) {
      const isBudget = err instanceof GatewayError && err.code === "budget_exhausted";
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await deps.finishActivity(activityId, {
        status: isBudget ? "budget" : "failed", summary: isBudget ? "Stopped: per-run budget reached." : `Failed: ${message}`,
        publicSummary: isBudget ? "Stopped at its budget cap." : "Run failed; the founder was notified in the console.",
        counts: {}, detail: { events, llmCalls }, costMicroUsd: Math.round(spent), error: message,
      });
      return { status: isBudget ? "budget" : "failed", agentId, activityId, costMicroUsd: Math.round(spent), error: message };
    }
  });
  return locked.locked ? { status: "skipped", reason: "locked", agentId } : locked.value;
}

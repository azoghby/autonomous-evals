/** Pure policy for company agents: enablement, budgets, caps. No I/O. */
import { COMPANY_AGENTS, type CompanyAgentId } from "./registry";

export type Env = Record<string, string | undefined>;

export const DEFAULT_DAILY_BUDGET_USD = 5;
export const MAX_DAILY_BUDGET_USD = 50;
export const DEFAULT_OUTREACH_DAILY_CAP = 20;
export const MAX_OUTREACH_DAILY_CAP = 50;

export const usdToMicro = (usd: number): number => Math.max(0, Math.round(usd * 1_000_000));
export const microToUsd = (micro: number): number => Math.round(micro) / 1_000_000;

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Company-wide daily spend cap across all five agents. COMPANY_AGENTS_DAILY_BUDGET_USD (default 5, max 50). */
export function dailyBudgetMicroUsd(env: Env = process.env): number {
  const usd = Math.min(num(env.COMPANY_AGENTS_DAILY_BUDGET_USD) ?? DEFAULT_DAILY_BUDGET_USD, MAX_DAILY_BUDGET_USD);
  return usdToMicro(usd);
}

/** Per-run cap: COMPANY_AGENT_<ID>_RUN_BUDGET_USD or the registry default, never above the daily cap. */
export function runBudgetMicroUsd(agent: CompanyAgentId, env: Env = process.env): number {
  const override = num(env[`COMPANY_AGENT_${agent.toUpperCase()}_RUN_BUDGET_USD`]);
  return Math.min(usdToMicro(override ?? COMPANY_AGENTS[agent].runBudgetUsd), dailyBudgetMicroUsd(env));
}

/** Max new outreach drafts per UTC day. COMPANY_OUTREACH_DAILY_CAP (default 20, max 50). */
export function outreachDailyCap(env: Env = process.env): number {
  const n = num(env.COMPANY_OUTREACH_DAILY_CAP);
  return Math.min(Math.floor(n ?? DEFAULT_OUTREACH_DAILY_CAP), MAX_OUTREACH_DAILY_CAP);
}

export const isProduction = (env: Env = process.env): boolean =>
  env.VERCEL_ENV === "production" || (env.NODE_ENV === "production" && env.VERCEL_ENV === undefined && env.VERCEL === "1");

/**
 * Enabled = DB toggle if set, else env flag COMPANY_AGENT_<ID>_ENABLED ("1"/"0"), else the registry default
 * (in production only market_research/prospecting/planner default on; elsewhere everything defaults on).
 * COMPANY_AGENTS_KILL=1 turns every agent off regardless.
 */
export function isAgentEnabled(agent: CompanyAgentId, dbToggle: boolean | null | undefined, env: Env = process.env): boolean {
  if (env.COMPANY_AGENTS_KILL === "1") return false;
  if (typeof dbToggle === "boolean") return dbToggle;
  const flag = env[`COMPANY_AGENT_${agent.toUpperCase()}_ENABLED`];
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return isProduction(env) ? COMPANY_AGENTS[agent].defaultEnabledInProduction : true;
}

export type BudgetDecision = { ok: true; runBudgetMicroUsd: number } | { ok: false; reason: "daily_budget_exhausted" };

/** The run gets min(per-run cap, what is left of today's company budget). */
export function decideRunBudget(agent: CompanyAgentId, spentTodayMicroUsd: number, env: Env = process.env): BudgetDecision {
  const remaining = dailyBudgetMicroUsd(env) - Math.max(0, spentTodayMicroUsd);
  if (remaining <= 0) return { ok: false, reason: "daily_budget_exhausted" };
  return { ok: true, runBudgetMicroUsd: Math.min(runBudgetMicroUsd(agent, env), remaining) };
}

/** UTC day key YYYY-MM-DD. */
export const dayKey = (d: Date): string => d.toISOString().slice(0, 10);
export const startOfUtcDay = (d: Date): Date => new Date(`${dayKey(d)}T00:00:00.000Z`);

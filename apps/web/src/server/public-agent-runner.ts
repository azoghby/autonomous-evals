/**
 * Reusable core of a public-agent leaderboard run. Shared by scripts/public-agents.ts and /api/cron/public-agents.
 * No "server-only" import so the tsx script can use it. API keys are read from the env var NAMED on the agent row and never logged.
 */
import { randomUUID } from "node:crypto";
import { Suite, type Finding } from "@ae/core/contracts/index";
import type { EvalServices, ServiceContext } from "@ae/core/contracts/services";
import { createLiteServices } from "@ae/core/lite/index";
import { redTeamById } from "@ae/core/redteam/index";
import { PublicAgentInput, assertAuthorizedToTest } from "./leaderboard-agents";
import { SUITE_VERSION, scoreRun, toStoredFindings, percent, type StoredFinding } from "./leaderboard";
import { buildStandardSuite } from "./leaderboard-suite";

export const DEFAULT_BUDGET_MICRO_USD = 2_000_000;
export const DEFAULT_TIMEOUT_MIN = 15;

export class BudgetExceeded extends Error {
  constructor(spent: number, cap: number) { super(`budget exceeded: ${spent} > ${cap} micro-USD`); }
}

/** The standard suite, built deterministically in code (no filesystem, so it works in serverless bundles). */
export function loadStandardSuite(): Suite {
  return buildStandardSuite();
}

/** Findings from failed scenarios: deterministic, no extra model spend. Severity comes from the red-team library; designed scenarios are medium. */
export function derivedFindings(suite: Suite, results: Array<{ scenarioId: string; passed: boolean; detail: string }>): StoredFinding[] {
  const byId = new Map(suite.scenarios.map((s) => [s.id, s]));
  const failed = results.filter((r) => !r.passed);
  return toStoredFindings(failed.map((r) => {
    const sc = byId.get(r.scenarioId);
    const rt = redTeamById(r.scenarioId);
    return {
      title: sc?.title ?? r.scenarioId, severity: rt?.severity ?? "medium", category: sc?.category ?? "other", scenarioId: r.scenarioId,
      evidence: [{ excerpt: r.detail }],
    };
  }));
}

/** Key for the agent's target. AI Gateway accepts a Vercel OIDC token as bearer when no API key is set. */
export function resolveApiKey(authEnvVar: string | null | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  if (!authEnvVar) return undefined;
  return env[authEnvVar] ?? (authEnvVar === "AI_GATEWAY_API_KEY" ? env.VERCEL_OIDC_TOKEN : undefined);
}

export interface RunOptions {
  suite: Suite;
  budgetMicroUsd?: number;
  timeoutMin?: number;
  dryRun?: boolean;
  investigate?: boolean;
  log?: (line: string) => void;
  /** Test seam; defaults to the lite engine. */
  services?: EvalServices;
}

export interface RunOutcome { slug: string; dryRun: boolean; passed?: number; total?: number; findings?: number; costMicroUsd?: number }

export async function runPublicAgent(row: PublicAgentInput, opts: RunOptions): Promise<RunOutcome> {
  const { suite } = opts;
  const budget = opts.budgetMicroUsd ?? DEFAULT_BUDGET_MICRO_USD;
  const timeoutMin = opts.timeoutMin ?? DEFAULT_TIMEOUT_MIN;
  const log = opts.log ?? ((l: string) => console.log(l));
  assertAuthorizedToTest(row);
  const apiKey = resolveApiKey(row.authEnvVar);
  const plan = `${row.slug}: ${row.model} @ ${row.endpointUrl} | ${suite.scenarios.length} scenarios | budget $${(budget / 1e6).toFixed(2)} | key ${row.authEnvVar ? (apiKey ? `from $${row.authEnvVar}` : `MISSING $${row.authEnvVar}`) : "none"}`;
  if (opts.dryRun) { log(`[dry-run] ${plan}`); return { slug: row.slug, dryRun: true }; }
  if (row.authEnvVar && !apiKey) throw new Error(`env var ${row.authEnvVar} is not set`);
  log(`[run] ${plan}`);

  const services = opts.services ?? createLiteServices();
  const { upsertAgent, insertRun } = await import("./leaderboard-db");
  const agent = await upsertAgent(PublicAgentInput.parse(row));

  let spent = 0;
  const ctx: ServiceContext = {
    jobId: randomUUID(), environment: "live", budgetMicroUsd: budget,
    async recordCost(entry) { spent += entry.microUsd; if (spent > budget) throw new BudgetExceeded(spent, budget); },
    async recordProgress(m, msg) { log(`  [${row.slug}] ${m}: ${msg.slice(0, 120)}`); },
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${timeoutMin} min`)), timeoutMin * 60_000); timer.unref?.(); });
  try {
    const target = { url: row.endpointUrl, model: row.model, ...(apiKey ? { apiKey } : {}), systemPrompt: row.systemPrompt ?? "" };
    const run = await Promise.race([services.runSuite(ctx, suite, target), timeout]);
    const score = scoreRun(suite.scenarios, run.results);
    let findings = derivedFindings(suite, run.results);
    if (opts.investigate) {
      try {
        const f: Finding[] = await Promise.race([services.investigate(ctx, suite, [run]), timeout]);
        findings = toStoredFindings(f);
      } catch (e) { log(`  investigate failed, using derived findings: ${(e as Error).message}`); }
    }
    await insertRun({ agentId: agent.id, suiteVersion: SUITE_VERSION, ...score, findings, costMicroUsd: spent });
    log(`[done] ${row.slug}: ${score.passed}/${score.total} (${percent(score.passed / Math.max(1, score.total))}), ${findings.length} findings, $${(spent / 1e6).toFixed(3)}`);
    return { slug: row.slug, dryRun: false, passed: score.passed, total: score.total, findings: findings.length, costMicroUsd: spent };
  } catch (e) {
    // Partial spend is lost with the thrown run; surface it so callers can account for it.
    if (e instanceof Error) Object.assign(e, { spentMicroUsd: spent });
    throw e;
  } finally { if (timer) clearTimeout(timer); }
}

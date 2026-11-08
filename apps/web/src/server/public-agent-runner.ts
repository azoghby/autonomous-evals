import { objectivePassed, type RunScenarioResult } from "@ae/core/contracts/services";
/**
 * Reusable core of a public-agent leaderboard run. Shared by scripts/public-agents.ts and /api/cron/public-agents.
 * No "server-only" import so the tsx script can use it. API keys are read from the env var NAMED on the agent row and never logged.
 */
import { randomUUID } from "node:crypto";
import { Suite, type Finding } from "@ae/core/contracts/index";
import type { EvalServices, ServiceContext } from "@ae/core/contracts/services";
import { createLiteServices } from "@ae/core/lite/index";
import { LoopbackJsonTransport, TargetError, type JsonTransport } from "@ae/core/targets/transport";
import { decrypt } from "@ae/core/storage/crypto";
import { redTeamById } from "@ae/core/redteam/index";
import { PublicAgentInput, assertAuthorizedToTest, isLocalKind } from "./leaderboard-agents";
import { SUITE_VERSION, scoreRun, toStoredFindings, percent, type StoredFinding } from "./leaderboard";
import { buildStandardSuite } from "./leaderboard-suite";

export const DEFAULT_BUDGET_MICRO_USD = 2_000_000;
export const DEFAULT_TIMEOUT_MIN = 15;
/** Local multi-agent shims are slower than a bare model call (120s is LoopbackJsonTransport's per-request maximum). */
const LOCAL_TARGET_TIMEOUT_MS = 120_000;
/**
 * Agentic loops (e.g. smolagents' CodeAgent, up to 20 steps) can need minutes per turn, and a target error is scored as
 * a failed scenario. So a request that hits the per-request timeout is re-sent up to this many times; the shims
 * (scripts/demo/shims/oss_bb_common.py) join the identical in-flight turn instead of starting another, and cap a turn
 * at 580s themselves. The harness timeout therefore never fails a slow-but-working agent.
 */
export const LOCAL_TIMEOUT_RETRIES = 4;

/** Re-sends a loopback request that timed out (only code "timeout"; every other error passes through). */
export class PatientLoopbackTransport implements JsonTransport {
  constructor(private readonly inner: JsonTransport, private readonly retries = LOCAL_TIMEOUT_RETRIES) {}
  async post(endpoint: string, body: unknown, bearer?: string): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.inner.post(endpoint, body, bearer); }
      catch (e) { if (!(e instanceof TargetError && e.code === "timeout") || attempt >= this.retries) throw e; }
    }
  }
}

export class BudgetExceeded extends Error {
  constructor(spent: number, cap: number) { super(`budget exceeded: ${spent} > ${cap} micro-USD`); }
}

/** The standard suite, built deterministically in code (no filesystem, so it works in serverless bundles). */
export function loadStandardSuite(): Suite {
  return buildStandardSuite();
}

/** Findings from failed scenarios: deterministic, no extra model spend. Severity comes from the red-team library; designed scenarios are medium. */
export function derivedFindings(suite: Suite, results: RunScenarioResult[]): StoredFinding[] {
  const byId = new Map(suite.scenarios.map((s) => [s.id, s]));
  const failed = results.filter((r) => objectivePassed(r) === false);
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
  /** Existing public_agents.id: skips the upsert (cron path; avoids writing to public_agents). */
  agentId?: string;
  /** Owner-submitted agents: AES-GCM ciphertext of the owner's key (public_agents.api_key_ciphertext). Decrypted here, never logged. */
  apiKeyCiphertext?: string | null;
  /** Operator CLI only (--allow-local): permit local_reference agents on http://127.0.0.1. Never set by the web/cron path. */
  allowLocal?: boolean;
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
  const local = isLocalKind(row.kind);
  if (local && !opts.allowLocal) throw new Error(`${row.slug} is a local agent (kind ${row.kind}); it only runs from the CLI with --allow-local`);
  const ownerKey = !!opts.apiKeyCiphertext;
  const apiKey = ownerKey ? decrypt(opts.apiKeyCiphertext!) : resolveApiKey(row.authEnvVar);
  const keyNote = ownerKey ? "owner key (encrypted at rest)" : row.authEnvVar ? (apiKey ? `from $${row.authEnvVar}` : `MISSING $${row.authEnvVar}`) : "none";
  const plan = `${row.slug}: ${row.model} @ ${row.endpointUrl} | ${suite.scenarios.length} scenarios | budget $${(budget / 1e6).toFixed(2)} | key ${keyNote}`;
  if (opts.dryRun) { log(`[dry-run] ${plan}`); return { slug: row.slug, dryRun: true }; }
  if (!ownerKey && row.authEnvVar && !apiKey) throw new Error(`env var ${row.authEnvVar} is not set`);
  log(`[run] ${plan}`);

  const services = opts.services ?? (local
    ? createLiteServices({ allowLoopback: true, transport: new PatientLoopbackTransport(new LoopbackJsonTransport({ timeoutMs: LOCAL_TARGET_TIMEOUT_MS })) })
    : createLiteServices());
  const { upsertAgent, insertRun } = await import("./leaderboard-db");
  const agent = opts.agentId ? { id: opts.agentId } : await upsertAgent(PublicAgentInput.parse(row));

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
    if (run.results.some(r => objectivePassed(r) === undefined)) throw new Error("Public leaderboard requires complete objective results; rich assessments retained by evaluator.");
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

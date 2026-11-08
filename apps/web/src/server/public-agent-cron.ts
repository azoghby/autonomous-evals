/**
 * Scheduling for the public-agent leaderboard cron: pick the ONE agent that is most overdue, honour the daily budget,
 * and serialise ticks with a Postgres advisory lock. Pure selection helpers are exported for tests.
 * No schema changes: runs live in public_agent_runs, failed attempts are logged as zero-run `costs` rows (jobId null).
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { PublicAgentInput, assertAuthorizedToTest } from "./leaderboard-agents";
import { SUITE_VERSION } from "./leaderboard";
import { loadStandardSuite, runPublicAgent, type RunOutcome } from "./public-agent-runner";

export const DEFAULT_RERUN_HOURS = 24;
export const DEFAULT_DAILY_BUDGET_USD = 3;
/** Per-run budget cap (micro-USD); a standard run costs well under $0.10. */
export const PER_RUN_BUDGET_MICRO_USD = 500_000;
/** Leave headroom under maxDuration = 300 so the function can record the failure and return. */
export const RUN_TIMEOUT_MIN = 4.5;
/** After a failed attempt, leave that agent alone this long so one broken agent cannot starve the rest. */
export const FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
export const FAILURE_COST_SOURCE = "public_agent_cron_failure";
/** Arbitrary constant key ("pubagent" as an int8) for pg_try_advisory_lock. */
export const ADVISORY_LOCK_KEY = 0x7075626167656e74n;

export interface CandidateAgent {
  slug: string; name: string; active: boolean; termsUrl?: string | null; authorizedNote?: string | null; authEnvVar?: string | null;
  /** Optional owner-autopilot fields; absent on rows from a DB that has not been migrated yet. */
  status?: string | null; ownerEmail?: string | null; verifiedAt?: Date | string | null;
}
export interface Schedule { lastRanAt: ReadonlyMap<string, Date>; lastFailedAt?: ReadonlyMap<string, Date> }

export function readConfig(env: Record<string, string | undefined> = process.env) {
  const hours = Number(env.PUBLIC_AGENT_RERUN_HOURS);
  const usd = Number(env.PUBLIC_AGENT_DAILY_BUDGET_USD);
  return {
    minIntervalMs: (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_RERUN_HOURS) * 3_600_000,
    dailyBudgetMicroUsd: Math.round((env.PUBLIC_AGENT_DAILY_BUDGET_USD?.trim() && Number.isFinite(usd) && usd >= 0 ? usd : DEFAULT_DAILY_BUDGET_USD) * 1_000_000),
  };
}

function isAuthorized(a: CandidateAgent): boolean {
  if (a.status != null && a.status !== "active") return false; // paused / pending_verification / opted_out
  if (a.ownerEmail && !a.verifiedAt) return false; // owner-submitted agents must be verified
  try { assertAuthorizedToTest(a); return true; } catch { return false; }
}

/** The single agent to run now: active + authorized, due (never run, or last run older than the interval), not in failure cooldown; oldest first. */
export function pickNextAgent<T extends CandidateAgent>(agents: readonly T[], schedule: Schedule, now: Date, minIntervalMs: number): T | null {
  const due = agents
    .filter((a) => a.active && isAuthorized(a))
    .filter((a) => {
      const ran = schedule.lastRanAt.get(a.slug);
      const failed = schedule.lastFailedAt?.get(a.slug);
      if (failed && now.getTime() - failed.getTime() < FAILURE_COOLDOWN_MS) return false;
      return !ran || now.getTime() - ran.getTime() >= minIntervalMs;
    });
  due.sort((x, y) => (schedule.lastRanAt.get(x.slug)?.getTime() ?? -Infinity) - (schedule.lastRanAt.get(y.slug)?.getTime() ?? -Infinity) || x.slug.localeCompare(y.slug));
  return due[0] ?? null;
}

/** True while today's spend is still under the cap (spend >= cap stops the run). */
export const budgetAllows = (spentTodayMicroUsd: number, capMicroUsd: number): boolean => spentTodayMicroUsd < capMicroUsd;

export const startOfUtcDay = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

export type TickResult =
  | { status: "ran"; outcome: RunOutcome }
  | { status: "failed"; slug: string; error: string }
  | { status: "skipped"; reason: "locked" | "budget" | "nothing_due" | "no_agents" };

const p = schema.publicAgents;
const baseCols = {
  id: p.id, slug: p.slug, name: p.name, vendor: p.vendor, kind: p.kind, endpointUrl: p.endpointUrl, model: p.model, authEnvVar: p.authEnvVar,
  systemPrompt: p.systemPrompt, homepage: p.homepage, termsUrl: p.termsUrl, authorizedNote: p.authorizedNote, active: p.active,
};

/** Explicit columns (never `select *`) so this works before and after the owner-autopilot migration. */
async function loadAgents() {
  try {
    return await db().select({ ...baseCols, status: p.status, ownerEmail: p.ownerEmail, verifiedAt: p.verifiedAt }).from(p);
  } catch {
    return await db().select(baseCols).from(p);
  }
}

async function loadSchedule(now: Date) {
  const d = db();
  const agents = await loadAgents();
  const runs = await d.select({ slug: schema.publicAgents.slug, last: sql<Date>`max(${schema.publicAgentRuns.ranAt})` })
    .from(schema.publicAgentRuns).innerJoin(schema.publicAgents, eq(schema.publicAgents.id, schema.publicAgentRuns.agentId))
    .where(eq(schema.publicAgentRuns.suiteVersion, SUITE_VERSION)).groupBy(schema.publicAgents.slug);
  const fails = await d.select({ slug: schema.costs.agent, last: sql<Date>`max(${schema.costs.createdAt})` })
    .from(schema.costs).where(and(eq(schema.costs.source, FAILURE_COST_SOURCE), gte(schema.costs.createdAt, new Date(now.getTime() - FAILURE_COOLDOWN_MS)))).groupBy(schema.costs.agent);
  const toMap = (rows: Array<{ slug: string | null; last: Date | string }>) =>
    new Map(rows.filter((r) => r.slug).map((r) => [r.slug as string, new Date(r.last)]));
  return { agents, schedule: { lastRanAt: toMap(runs), lastFailedAt: toMap(fails) } satisfies Schedule };
}

/** Public-agent spend since UTC midnight: stored runs plus the partial spend of failed attempts. */
export async function spentTodayMicroUsd(now: Date): Promise<number> {
  const since = startOfUtcDay(now);
  const d = db();
  const [r] = await d.select({ v: sql<string>`coalesce(sum(${schema.publicAgentRuns.costMicroUsd}), 0)` }).from(schema.publicAgentRuns).where(gte(schema.publicAgentRuns.ranAt, since));
  const [f] = await d.select({ v: sql<string>`coalesce(sum(${schema.costs.microUsd}), 0)` }).from(schema.costs)
    .where(and(eq(schema.costs.source, FAILURE_COST_SOURCE), gte(schema.costs.createdAt, since)));
  return Number(r?.v ?? 0) + Number(f?.v ?? 0);
}

async function recordFailure(slug: string, microUsd: number, error: string): Promise<void> {
  await db().insert(schema.costs).values({ jobId: null, source: FAILURE_COST_SOURCE, agent: slug, microUsd, meta: { error: error.slice(0, 300) } });
}

/** One cron tick. Holds a session advisory lock on a dedicated connection for the whole run, so overlapping ticks skip. */
export async function runNextPublicAgent(now = new Date(), log: (l: string) => void = () => {}): Promise<TickResult> {
  const { Pool } = await import("@neondatabase/serverless");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    const { rows } = await client.query("select pg_try_advisory_lock($1::bigint) as ok", [ADVISORY_LOCK_KEY.toString()]);
    if (!rows[0]?.ok) return { status: "skipped", reason: "locked" };
    try {
      const cfg = readConfig();
      const { agents, schedule } = await loadSchedule(now);
      if (!agents.length) return { status: "skipped", reason: "no_agents" };
      if (!budgetAllows(await spentTodayMicroUsd(now), cfg.dailyBudgetMicroUsd)) return { status: "skipped", reason: "budget" };
      const next = pickNextAgent(agents, schedule, now, cfg.minIntervalMs);
      if (!next) return { status: "skipped", reason: "nothing_due" };
      try {
        const outcome = await runPublicAgent(PublicAgentInput.parse(next), {
          suite: loadStandardSuite(), agentId: next.id, budgetMicroUsd: PER_RUN_BUDGET_MICRO_USD, timeoutMin: RUN_TIMEOUT_MIN, log,
        });
        return { status: "ran", outcome };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const spent = (e as { spentMicroUsd?: number }).spentMicroUsd ?? 0;
        await recordFailure(next.slug, spent, msg).catch(() => {});
        return { status: "failed", slug: next.slug, error: msg };
      }
    } finally {
      await client.query("select pg_advisory_unlock($1::bigint)", [ADVISORY_LOCK_KEY.toString()]).catch(() => {});
    }
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

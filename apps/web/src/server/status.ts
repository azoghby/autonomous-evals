import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@ae/core/db/client";
import journal from "../../../../packages/core/src/db/migrations/meta/_journal.json";
import vercelConfig from "../../vercel.json";
import {
  STALE_RUNNING_MS, classifyActivity, cronIntervalMs, describeCron, formatAge, summarizeStatus, toPublicStatus, ttlCache,
  type ActivityState, type OverallStatus, type Probe, type ProbeLevel, type PublicStatus,
} from "./status-logic";

const PROBE_TIMEOUT_MS = 3000;
const SLOW_DB_MS = 1500;
const WORKING_STATES = ["planning", "running", "investigating"];

export interface AppInfo {
  environment: string; commit: string; region: string; nodeEnv: string; serverTime: string;
}
export interface DatabaseInfo {
  latencyMs: number;
  migrations: null | { applied: number; expected: number; pending: number; latestAppliedAt: string | null; error?: string };
}
export interface CountRow { key: string; count: number }
export interface JobsInfo { byState: CountRow[]; total: number; staleRunning: number }
export interface SandboxInfo { byStatus: CountRow[]; total: number; staleRunning: number }
export interface CronInfo {
  path: string; schedule: string; cadence: string;
  /** Table the "last recorded activity" is derived from, or null when no clear mapping exists. */
  source: string | null;
  lastActivityAt: string | null; lastActivityAge: string; state: ActivityState | "unmapped";
}
export interface StatusSummary {
  generatedAt: string;
  overall: OverallStatus;
  app: AppInfo;
  probes: Probe[];
  database: DatabaseInfo | null;
  jobs: JobsInfo | null;
  sandbox: SandboxInfo | null;
  crons: CronInfo[] | null;
}

class ProbeTimeoutError extends Error {
  override name = "TimeoutError";
}

function withTimeout<T>(p: Promise<T>, ms = PROBE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ProbeTimeoutError(`probe exceeded ${ms}ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Error class only (never the message, which may embed connection details). */
function errorClass(e: unknown): string {
  if (!(e instanceof Error)) return "UnknownError";
  const cause = e.cause instanceof Error && e.cause.name !== "Error" ? ` (${e.cause.name})` : "";
  return `${e.name}${cause}`;
}

function rowsOf<T>(res: unknown): T[] {
  return (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as T[];
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await withTimeout(fn());
  return { value, ms: Math.round((performance.now() - t0) * 10) / 10 };
}

function toCounts(rows: { k: string; n: number | string }[]): CountRow[] {
  return rows.map((r) => ({ key: r.k, count: Number(r.n) })).sort((a, b) => b.count - a.count);
}

async function databaseProbe(): Promise<{ data: DatabaseInfo; ms: number }> {
  const ping = await timed(() => db().execute(sql`select 1 as ok`));
  let migrations: DatabaseInfo["migrations"] = null;
  const expected = journal.entries.length;
  try {
    const res = await withTimeout(db().execute(sql`select count(*)::int as n, max(created_at) as latest from drizzle.__drizzle_migrations`));
    const [row] = rowsOf<{ n: number | string; latest: number | string | null }>(res);
    const applied = Number(row?.n ?? 0);
    const latest = row?.latest != null ? new Date(Number(row.latest)).toISOString() : null;
    // Pending = journal entries newer than the latest applied migration. Counting rows misleads:
    // a DB can hold extra history rows (e.g. Track B sidecars) and still be up to date.
    const latestMs = row?.latest != null ? Number(row.latest) : 0;
    const pending = journal.entries.filter((e) => Number(e.when) > latestMs).length;
    migrations = { applied, expected, pending, latestAppliedAt: latest };
  } catch (e) {
    migrations = { applied: 0, expected, pending: 0, latestAppliedAt: null, error: errorClass(e) };
  }
  return { data: { latencyMs: ping.ms, migrations }, ms: ping.ms };
}

async function jobsProbe(now: Date): Promise<{ data: JobsInfo; ms: number }> {
  const cutoff = new Date(now.getTime() - STALE_RUNNING_MS);
  const { value, ms } = await timed(async () => {
    const [byState, stale] = await Promise.all([
      db().execute(sql`select state::text as k, count(*)::int as n from jobs group by state`),
      db().execute(sql`select count(*)::int as n from jobs where state::text in (${sql.join(WORKING_STATES.map((s) => sql`${s}`), sql`, `)}) and updated_at < ${cutoff.toISOString()}::timestamptz`),
    ]);
    return { byState: toCounts(rowsOf(byState)), stale: Number(rowsOf<{ n: number }>(stale)[0]?.n ?? 0) };
  });
  return { data: { byState: value.byState, total: value.byState.reduce((a, r) => a + r.count, 0), staleRunning: value.stale }, ms };
}

async function sandboxProbe(now: Date): Promise<{ data: SandboxInfo; ms: number }> {
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const cutoff = new Date(now.getTime() - STALE_RUNNING_MS).toISOString();
  const { value, ms } = await timed(async () => {
    const [byStatus, stale] = await Promise.all([
      db().execute(sql`select status as k, count(*)::int as n from sandbox_runs where created_at >= ${since}::timestamptz group by status`),
      db().execute(sql`select count(*)::int as n from sandbox_runs where status = 'running' and updated_at < ${cutoff}::timestamptz`),
    ]);
    return { byStatus: toCounts(rowsOf(byStatus)), stale: Number(rowsOf<{ n: number }>(stale)[0]?.n ?? 0) };
  });
  return { data: { byStatus: value.byStatus, total: value.byStatus.reduce((a, r) => a + r.count, 0), staleRunning: value.stale }, ms };
}

const COMPANY_CRONS: Record<string, string> = {
  "/api/cron/company/market-research": "market_research",
  "/api/cron/company/prospecting": "prospecting",
  "/api/cron/company/outreach": "outreach",
  "/api/cron/company/planner": "planner",
  "/api/cron/company/onboarding": "onboarding",
};

async function maxTime(query: ReturnType<typeof sql>): Promise<Date | null> {
  const [row] = rowsOf<{ t: string | Date | null }>(await db().execute(query));
  return row?.t ? new Date(row.t) : null;
}

async function cronsProbe(now: Date): Promise<{ data: CronInfo[]; ms: number }> {
  const { value, ms } = await timed(async () => {
    const [monitoring, followUps, publicAgents, company] = await Promise.all([
      maxTime(sql`select max(ran_at) as t from monitoring_runs`),
      maxTime(sql`select max(sent_at) as t from follow_ups`),
      maxTime(sql`select max(ran_at) as t from public_agent_runs`),
      db().execute(sql`select agent_id as k, max(started_at) as t from company_agent_activity group by agent_id`),
    ]);
    const byAgent = new Map(rowsOf<{ k: string; t: string | Date }>(company).map((r) => [r.k, new Date(r.t)]));
    return { monitoring, followUps, publicAgents, byAgent };
  });
  const map = (path: string): { source: string; at: Date | null } | null => {
    if (path === "/api/cron/monitoring") return { source: "monitoring_runs", at: value.monitoring };
    if (path === "/api/cron/follow-ups") return { source: "follow_ups", at: value.followUps };
    if (path === "/api/cron/public-agents") return { source: "public_agent_runs", at: value.publicAgents };
    const agent = COMPANY_CRONS[path];
    return agent ? { source: `company_agent_activity · ${agent}`, at: value.byAgent.get(agent) ?? null } : null;
  };
  const data = vercelConfig.crons.map((c): CronInfo => {
    const m = map(c.path);
    const base = { path: c.path, schedule: c.schedule, cadence: describeCron(c.schedule) };
    if (!m) return { ...base, source: null, lastActivityAt: null, lastActivityAge: "no recorded activity", state: "unmapped" };
    return {
      ...base, source: m.source, lastActivityAt: m.at?.toISOString() ?? null,
      lastActivityAge: m.at ? formatAge(m.at, now) : "no recorded activity",
      state: classifyActivity(m.at, cronIntervalMs(c.schedule), now),
    };
  });
  return { data, ms };
}

function failed(id: string, label: string, critical: boolean, reason: unknown): Probe {
  return { id, label, critical, level: "down", latencyMs: null, notes: [], errorClass: errorClass(reason) };
}

function probe(id: string, label: string, critical: boolean, ms: number, notes: string[], level: ProbeLevel = notes.length ? "degraded" : "ok"): Probe {
  return { id, label, critical, level, latencyMs: ms, notes, errorClass: null };
}

export function appInfo(now: Date): AppInfo {
  const e = process.env;
  return {
    environment: e.VERCEL_ENV ?? "local",
    commit: e.VERCEL_GIT_COMMIT_SHA ? e.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : "local",
    region: e.VERCEL_REGION ?? "local",
    nodeEnv: e.NODE_ENV ?? "local",
    serverTime: now.toISOString(),
  };
}

/** Live health snapshot. Every probe fails independently and is bounded by a ~3s timeout. */
export async function getStatusSummary(): Promise<StatusSummary> {
  const now = new Date();
  const [dbR, jobsR, sandboxR, cronsR] = await Promise.allSettled([databaseProbe(), jobsProbe(now), sandboxProbe(now), cronsProbe(now)]);
  const probes: Probe[] = [];
  let database: DatabaseInfo | null = null, jobs: JobsInfo | null = null, sandbox: SandboxInfo | null = null, crons: CronInfo[] | null = null;

  if (dbR.status === "fulfilled") {
    database = dbR.value.data;
    probes.push(probe("database", "Database", true, dbR.value.ms, dbR.value.ms > SLOW_DB_MS ? [`slow round trip (${dbR.value.ms}ms)`] : []));
    const m = database.migrations;
    if (m?.error) probes.push({ id: "migrations", label: "Migrations", critical: false, level: "degraded", latencyMs: null, notes: [], errorClass: m.error });
    else if (m) probes.push(probe("migrations", "Migrations", false, 0, m.pending ? [`${m.pending} pending migration${m.pending === 1 ? "" : "s"}`] : []));
  } else probes.push(failed("database", "Database", true, dbR.reason));

  if (jobsR.status === "fulfilled") {
    jobs = jobsR.value.data;
    probes.push(probe("jobs", "Job pipeline", false, jobsR.value.ms, jobs.staleRunning ? [`${jobs.staleRunning} stale working job${jobs.staleRunning === 1 ? "" : "s"}`] : []));
  } else probes.push(failed("jobs", "Job pipeline", false, jobsR.reason));

  if (sandboxR.status === "fulfilled") {
    sandbox = sandboxR.value.data;
    probes.push(probe("sandbox", "Sandbox runs", false, sandboxR.value.ms, sandbox.staleRunning ? [`${sandbox.staleRunning} stale running run${sandbox.staleRunning === 1 ? "" : "s"}`] : []));
  } else probes.push(failed("sandbox", "Sandbox runs", false, sandboxR.reason));

  if (cronsR.status === "fulfilled") {
    crons = cronsR.value.data;
    probes.push(probe("crons", "Scheduled jobs", false, cronsR.value.ms, []));
  } else probes.push(failed("crons", "Scheduled jobs", false, cronsR.reason));

  return { generatedAt: now.toISOString(), overall: summarizeStatus(probes), app: appInfo(now), probes, database, jobs, sandbox, crons };
}

/** Public cache window: anonymous traffic triggers at most one probe sweep (~10 queries) per instance per window. */
export const PUBLIC_STATUS_TTL_MS = 20_000;

/** Anonymous view (overall + per-component level only), memoized for PUBLIC_STATUS_TTL_MS. */
export const getPublicStatus: () => Promise<PublicStatus> = ttlCache(
  async () => toPublicStatus(await getStatusSummary()),
  PUBLIC_STATUS_TTL_MS,
);

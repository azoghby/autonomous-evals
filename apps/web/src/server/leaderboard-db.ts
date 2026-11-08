/** DB access for the leaderboard. No server-only import so scripts/public-agents.ts can use it. Never throws on missing tables when reading. */
import { and, desc, eq, or } from "drizzle-orm";
import { db } from "../../../../packages/core/src/db/client";
import { publicAgents, publicAgentRuns, ENSURE_TABLES_SQL } from "./leaderboard-schema";
import {
  SUITE_VERSION, latestRunPerAgent, rankEntries, type ByCategory, type RankedEntry, type StoredFinding,
} from "./leaderboard";
import type { PublicAgentInput } from "./leaderboard-agents";

export type PublicAgentRow = typeof publicAgents.$inferSelect;

export async function ensureLeaderboardTables(): Promise<void> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(process.env.DATABASE_URL!);
  for (const stmt of ENSURE_TABLES_SQL) await sql.query(stmt);
}

export async function upsertAgent(input: PublicAgentInput): Promise<PublicAgentRow> {
  const values = {
    slug: input.slug, name: input.name, vendor: input.vendor, kind: input.kind, endpointUrl: input.endpointUrl, model: input.model,
    authEnvVar: input.authEnvVar ?? null, systemPrompt: input.systemPrompt ?? null, homepage: input.homepage ?? null,
    termsUrl: input.termsUrl ?? null, authorizedNote: input.authorizedNote ?? null, active: input.active,
  };
  const [row] = await db().insert(publicAgents).values(values).onConflictDoUpdate({ target: publicAgents.slug, set: values }).returning();
  return row!;
}

export async function listAgents(): Promise<PublicAgentRow[]> {
  return db().select().from(publicAgents).orderBy(publicAgents.name);
}

export async function getAgentBySlug(slug: string): Promise<PublicAgentRow | undefined> {
  const [row] = await db().select().from(publicAgents).where(eq(publicAgents.slug, slug)).limit(1);
  return row;
}

export interface NewRun {
  agentId: string; suiteVersion: string; passed: number; total: number;
  byCategory: ByCategory; findings: StoredFinding[]; costMicroUsd: number; jobId?: string | null;
}
export async function insertRun(run: NewRun): Promise<void> {
  await db().insert(publicAgentRuns).values({ ...run, jobId: run.jobId ?? null });
}

async function loadRanking(suiteVersion: string): Promise<{ agents: PublicAgentRow[]; ranked: RankedEntry[]; runs: Array<typeof publicAgentRuns.$inferSelect> }> {
  const [agents, runs] = await Promise.all([
    db().select().from(publicAgents).where(and(eq(publicAgents.visibility, "public"), or(eq(publicAgents.active, true), eq(publicAgents.status, "paused")))),
    db().select().from(publicAgentRuns).orderBy(desc(publicAgentRuns.ranAt)).limit(2000),
  ]);
  const latest = latestRunPerAgent(runs, suiteVersion);
  const items = agents.flatMap((a) => {
    const r = latest.get(a.id);
    return r ? [{
      agent: { slug: a.slug, name: a.name, vendor: a.vendor, kind: a.kind, model: a.model },
      run: { suiteVersion: r.suiteVersion, ranAt: r.ranAt, passed: r.passed, total: r.total, byCategory: r.byCategory, findings: r.findings as StoredFinding[] },
    }] : [];
  });
  return { agents, ranked: rankEntries(items), runs };
}

/** Leaderboard rows; [] when the tables do not exist yet or the DB is unreachable (page shows the empty state). */
export async function getLeaderboard(suiteVersion = SUITE_VERSION): Promise<{ entries: RankedEntry[]; ok: boolean }> {
  if (process.env.LEADERBOARD_FIXTURE === "1" && process.env.NODE_ENV !== "production") {
    const { fixtureEntries } = await import("./leaderboard-fixture");
    return { entries: fixtureEntries(), ok: true };
  }
  try { return { entries: (await loadRanking(suiteVersion)).ranked, ok: true }; }
  catch (e) { console.error("[leaderboard] load failed", e instanceof Error ? e.message : e); return { entries: [], ok: false }; }
}

export interface AgentDetail {
  entry: RankedEntry;
  agent: Pick<PublicAgentRow, "homepage" | "kind" | "model" | "vendor" | "name" | "slug">;
  history: Array<{ ranAt: Date; passRate: number }>;
  totalRanked: number;
}
export async function getAgentDetail(slug: string, suiteVersion = SUITE_VERSION): Promise<AgentDetail | null> {
  if (process.env.LEADERBOARD_FIXTURE === "1" && process.env.NODE_ENV !== "production") {
    const { fixtureEntries } = await import("./leaderboard-fixture");
    const entries = fixtureEntries(); const entry = entries.find((e) => e.slug === slug);
    return entry ? { entry, agent: { ...entry, homepage: "https://vercel.com/ai-gateway", model: entry.model ?? "" }, history: [{ ranAt: new Date("2026-11-06"), passRate: 0.7 }, { ranAt: entry.run.ranAt, passRate: entry.passRate }], totalRanked: entries.length } : null;
  }
  try {
    const { agents, ranked, runs } = await loadRanking(suiteVersion);
    const entry = ranked.find((e) => e.slug === slug);
    const agent = agents.find((a) => a.slug === slug);
    if (!entry || !agent) return null;
    const history = runs.filter((r) => r.agentId === agent.id && r.suiteVersion === suiteVersion && r.total > 0)
      .map((r) => ({ ranAt: r.ranAt, passRate: r.passed / r.total })).reverse().slice(-12);
    return { entry, agent, history, totalRanked: ranked.length };
  } catch (e) { console.error("[leaderboard] detail failed", e instanceof Error ? e.message : e); return null; }
}

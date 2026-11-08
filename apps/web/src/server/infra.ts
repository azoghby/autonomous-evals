import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@ae/core/db/client";
import { createNeonClient, type NeonClient } from "@ae/core/neon/api";

export interface InfraReport {
  generatedAt: string;
  neon: null | {
    projectId: string; region: string | null; pgVersion: number | null;
    branchCount: number;
    jobBranches: { id: string; name: string; expiresAt: string | null; state: string | null }[];
    snapshots: { id: string; name: string; createdAt: string | null; expiresAt: string | null; manual: boolean | null }[];
  };
  neonError: string | null;
  slowQueries: { query: string; meanMs: number; calls: number }[];
  slowQueriesError: string | null;
}

const QUERY_MAX = 200;
const truncate = (s: string) => (s.length > QUERY_MAX ? `${s.slice(0, QUERY_MAX)}…` : s);

async function neonSection(client: NeonClient): Promise<NonNullable<InfraReport["neon"]>> {
  const [project, branches, snapshots] = await Promise.all([client.describeProject(), client.listBranches(), client.listSnapshots()]);
  return {
    projectId: String(project.id ?? ""),
    region: (project.region_id as string | undefined) ?? null,
    pgVersion: (project.pg_version as number | undefined) ?? null,
    branchCount: branches.length,
    jobBranches: branches.filter((b) => b.name.startsWith("job-"))
      .map((b) => ({ id: b.id, name: b.name, expiresAt: b.expires_at ?? null, state: b.current_state ?? null })),
    snapshots: [...snapshots].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")).slice(0, 10)
      .map((s) => ({ id: s.id, name: s.name, createdAt: s.created_at ?? null, expiresAt: s.expires_at ?? null, manual: s.manual ?? null })),
  };
}

async function slowQueries(): Promise<InfraReport["slowQueries"]> {
  const rows = await db().execute(sql`
    SELECT query, mean_exec_time AS mean_ms, calls
    FROM pg_stat_statements
    WHERE query NOT ILIKE '%pg_stat_statements%'
    ORDER BY mean_exec_time DESC LIMIT 5`);
  const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as
    { query: string; mean_ms: number | string; calls: number | string }[];
  return list.map((r) => ({ query: truncate(String(r.query)), meanMs: Number(Number(r.mean_ms).toFixed(2)), calls: Number(r.calls) }));
}

const msg = (e: unknown) => (e instanceof Error ? e.message : "unknown error");

/** Read-only infra snapshot. Each section fails independently so a missing key doesn't hide the rest. */
export async function getInfraReport(opts: { client?: NeonClient } = {}): Promise<InfraReport> {
  const report: InfraReport = { generatedAt: new Date().toISOString(), neon: null, neonError: null, slowQueries: [], slowQueriesError: null };
  const [neon, slow] = await Promise.allSettled([
    // Build the client inside the async section so a missing NEON_API_KEY rejects here (per-section error), not synchronously.
    (async () => neonSection(opts.client ?? createNeonClient()))(),
    slowQueries(),
  ]);
  if (neon.status === "fulfilled") report.neon = neon.value; else report.neonError = msg(neon.reason);
  if (slow.status === "fulfilled") report.slowQueries = slow.value; else report.slowQueriesError = msg(slow.reason);
  return report;
}

import { getLeaderboard } from "@/server/leaderboard-db";
import { SUITE_VERSION } from "@/server/leaderboard";

export const revalidate = 300;

/** Public JSON of the current ranking (no findings detail, no endpoints, no prompts). */
export async function GET() {
  const { entries, ok } = await getLeaderboard();
  const body = {
    suite: SUITE_VERSION,
    agents: entries.map((e) => ({
      rank: e.rank, slug: e.slug, name: e.name, vendor: e.vendor, kind: e.kind,
      passRate: e.passRate, redTeamPassRate: e.redTeamRate, criticalFindings: e.criticalCount,
      passed: e.run.passed, total: e.run.total, lastRunAt: e.run.ranAt.toISOString(),
    })),
  };
  return Response.json(body, { status: ok ? 200 : 503, headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" } });
}

import { unstable_cache } from "next/cache";
import { getRevenueStats, revenueSince } from "@/server/revenue";

export const dynamic = "force-dynamic";
const REVALIDATE_SECONDS = 60;

const cached = unstable_cache(
  async (since: string) => getRevenueStats(new Date(since)),
  ["stats-revenue"],
  { revalidate: REVALIDATE_SECONDS },
);

export async function GET() {
  try {
    const stats = await cached(revenueSince().toISOString());
    return Response.json(stats, { headers: { "Cache-Control": `public, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=${REVALIDATE_SECONDS}` } });
  } catch (err) {
    console.error("revenue stats failed", err);
    return Response.json({ error: "unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

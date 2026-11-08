import { getAgentDetail } from "@/server/leaderboard-db";
import { badgeText, badgeTone } from "@/server/leaderboard";
import { invalidBadgeSvg, renderBadgeSvg } from "@/server/share-core";

// Dynamic + CDN Cache-Control (s-maxage) instead of ISR, so a 404 for an unknown slug is never stored.
export const dynamic = "force-dynamic";
const SVG = "image/svg+xml; charset=utf-8";
const COLORS = { ok: "#2EA66A", warn: "#C98A1B", danger: "#D2493D", none: "#6B7280" } as const;

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const d = /^[a-z0-9-]{2,63}$/.test(slug) ? await getAgentDetail(slug) : null;
  const headers = { "Content-Type": SVG, "Cache-Control": "public, max-age=300, s-maxage=300", "X-Robots-Tag": "noindex" };
  // Unknown slugs must not be cached publicly (a CDN would keep serving 404 after the agent is listed).
  if (!d) return new Response(invalidBadgeSvg(), { status: 404, headers: { ...headers, "Cache-Control": "no-store" } });
  return new Response(renderBadgeSvg("Standard Evals", badgeText(d.entry), COLORS[badgeTone(d.entry)]), { headers });
}

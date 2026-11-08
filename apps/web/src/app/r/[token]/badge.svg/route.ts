import { clientIp, rateLimit } from "@/server/rate-limit";
import { loadSharedReport } from "@/server/share";
import { badgeColor, badgeMessage, invalidBadgeSvg, renderBadgeSvg } from "@/server/share-core";

export const dynamic = "force-dynamic";
const SVG = "image/svg+xml; charset=utf-8";

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const rl = await rateLimit(`badge:${clientIp(req)}`, 120, 60);
  if (!rl.ok) return new Response(invalidBadgeSvg(), { status: 429, headers: { "Content-Type": SVG, "Retry-After": String(rl.retryAfter), "Cache-Control": "no-store" } });
  const { token } = await ctx.params;
  const report = await loadSharedReport(token);
  if (!report) return new Response(invalidBadgeSvg(), { status: 404, headers: { "Content-Type": SVG, "Cache-Control": "public, max-age=60" } });
  const svg = renderBadgeSvg("Standard Evals", badgeMessage(report), badgeColor(report.openCounts));
  return new Response(svg, { headers: { "Content-Type": SVG, "Cache-Control": "public, max-age=60, s-maxage=60", "X-Robots-Tag": "noindex" } });
}

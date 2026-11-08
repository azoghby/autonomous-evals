import { requireOperator } from "@/server/http";
import { PUBLIC_STATUS_TTL_MS, getPublicStatus, getStatusSummary } from "@/server/status";

export const dynamic = "force-dynamic";

const PUBLIC_MAX_AGE_S = Math.round(PUBLIC_STATUS_TTL_MS / 1000);

/**
 * Public: overall level plus a level per component, cached for ~20s (in-process and at the CDN).
 * `?detail=1`: the full probe summary (counts, crons, migrations, deploy info), operators only, never cached.
 */
export async function GET(request: Request): Promise<Response> {
  const detail = new URL(request.url).searchParams.get("detail") === "1";
  if (detail) {
    const auth = await requireOperator();
    if (auth.res) return auth.res;
    const summary = await getStatusSummary();
    return Response.json(summary, {
      status: summary.overall.level === "down" ? 503 : 200,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  const status = await getPublicStatus();
  return Response.json(status, {
    status: status.overall.level === "down" ? 503 : 200,
    headers: { "Cache-Control": `public, max-age=${PUBLIC_MAX_AGE_S}, s-maxage=${PUBLIC_MAX_AGE_S}` },
  });
}

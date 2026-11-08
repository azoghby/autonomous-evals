import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@ae/core/db/client";

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the current window resets (0 when ok). */
  retryAfter: number;
}

/**
 * Fixed-window counter in Neon, one atomic upsert per call. Fallback behind the Vercel Firewall
 * rate-limit rules. Fails open on DB errors so a limiter outage never blocks real users.
 *
 *   const rl = await rateLimit(`request-link:${ip}`, 5, 600);
 *   if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
 */
export async function rateLimit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
  try {
    const res = await db().execute(sql`
      INSERT INTO rate_limits AS r (key, window_start, count)
      VALUES (${key}, now(), 1)
      ON CONFLICT (key) DO UPDATE SET
        window_start = CASE WHEN r.window_start <= now() - make_interval(secs => ${windowSec}) THEN now() ELSE r.window_start END,
        count = CASE WHEN r.window_start <= now() - make_interval(secs => ${windowSec}) THEN 1 ELSE r.count + 1 END
      RETURNING count,
        GREATEST(0, CEIL(EXTRACT(EPOCH FROM (window_start + make_interval(secs => ${windowSec}) - now()))))::int AS retry_after
    `);
    const row = res.rows[0] as { count: number | string; retry_after: number | string } | undefined;
    if (!row) return { ok: true, retryAfter: 0 };
    const ok = Number(row.count) <= limit;
    return { ok, retryAfter: ok ? 0 : Math.max(1, Number(row.retry_after)) };
  } catch (err) {
    console.error("rateLimit failed open", err);
    return { ok: true, retryAfter: 0 };
  }
}

/** Best-effort client IP from Vercel's forwarding headers. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip") || "unknown";
}

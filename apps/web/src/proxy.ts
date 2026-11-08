import { NextResponse, type NextRequest } from "next/server";
import { clientIp, rateLimit } from "@/server/rate-limit";

/** Public share pages (/r/<token>): rate limited here so a throttled request gets a real 429 (pages cannot set status). */
export const SHARE_PAGE_LIMIT = 60;
export const SHARE_PAGE_WINDOW_SEC = 60;

export async function proxy(request: NextRequest) {
  const rl = await rateLimit(`share-page:${clientIp(request)}`, SHARE_PAGE_LIMIT, SHARE_PAGE_WINDOW_SEC);
  if (!rl.ok) {
    return new NextResponse(`Too many requests. Try again in ${rl.retryAfter}s.`, {
      status: 429, headers: { "Retry-After": String(rl.retryAfter), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return NextResponse.next();
}

// One segment only: /r/<token>/badge.svg has its own limiter.
export const config = { matcher: ["/r/:token"] };

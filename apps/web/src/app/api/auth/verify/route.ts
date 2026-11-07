import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyMagicLink } from "@ae/core/auth/magic-link";
import { safeNextPath } from "@ae/core/auth/tokens";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/session";

/**
 * GET never consumes the token (link scanners / prefetchers / login-CSRF): it only redirects to the
 * confirm page, where a human click POSTs here.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const rawNext = url.searchParams.get("next");
  if (!token || token.length > 200) {
    return NextResponse.redirect(new URL("/signin?auth_error=invalid", url), 303);
  }
  const qs = new URLSearchParams({ token });
  if (rawNext && safeNextPath(rawNext, "") !== "") qs.set("next", safeNextPath(rawNext));
  return NextResponse.redirect(new URL(`/signin/confirm?${qs}`, url), 303);
}

const Body = z.object({ token: z.string().min(1).max(200), next: z.string().max(2000).nullish() });

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const next = safeNextPath(parsed.data.next);
  const result = await verifyMagicLink(parsed.data.token);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 });
  const res = NextResponse.json({ redirect: next }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, result.sessionToken, sessionCookieOptions(result.expiresAt));
  return res;
}

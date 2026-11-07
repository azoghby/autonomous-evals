import { NextResponse } from "next/server";
import { verifyMagicLink } from "@ae/core/auth/magic-link";
import { safeNextPath } from "@ae/core/auth/tokens";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/session";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const rawNext = url.searchParams.get("next");
  const next = safeNextPath(rawNext);
  const fail = (reason: string) => {
    const qs = new URLSearchParams({ auth_error: reason });
    if (rawNext && safeNextPath(rawNext, "") !== "") qs.set("next", next);
    return NextResponse.redirect(new URL(`/signin?${qs}`, url), 303);
  };
  if (!token || token.length > 200) return fail("invalid");
  const result = await verifyMagicLink(token);
  if (!result.ok) return fail(result.reason);
  const res = NextResponse.redirect(new URL(next, url), 303);
  res.cookies.set(SESSION_COOKIE, result.sessionToken, sessionCookieOptions(result.expiresAt));
  return res;
}

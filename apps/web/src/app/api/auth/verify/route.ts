import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyMagicLink } from "@ae/core/auth/magic-link";
import { safeNextPath } from "@ae/core/auth/tokens";
import { SESSION_COOKIE, sessionCookieOptions } from "@/server/session";
import { SESSION_HINT_COOKIE } from "@/lib/session-hint";
import { isSameOrigin } from "@/server/oauth/consent";
import { originOf } from "@/server/oauth/service";
import { readBoundedJson } from "@/server/body-limit";

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

/**
 * Login CSRF: a cross-site form could otherwise POST a token the attacker minted and sign the victim into the
 * attacker's account. Require JSON (not sendable by a plain HTML form) and a same-origin Origin/Referer.
 */
export async function POST(req: Request) {
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  if (!isSameOrigin(req, originOf(req))) return NextResponse.json({ error: "cross_site" }, { status: 403 });
  const body = await readBoundedJson(req, 16 * 1024);
  if (!body.ok) return body.res;
  const parsed = Body.safeParse(body.value);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const next = safeNextPath(parsed.data.next);
  const result = await verifyMagicLink(parsed.data.token);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 400 });
  const res = NextResponse.json({ redirect: next }, { headers: { "Cache-Control": "no-store" } });
  res.cookies.set(SESSION_COOKIE, result.sessionToken, sessionCookieOptions(result.expiresAt));
  // Readable hint (no credential) so client UI can skip authenticated fetches for signed-out visitors.
  res.cookies.set(SESSION_HINT_COOKIE, "1", { path: "/", sameSite: "lax", secure: process.env.NODE_ENV === "production", expires: result.expiresAt });
  return res;
}

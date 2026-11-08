import { customerForSessionToken } from "@ae/core/auth/magic-link";
import { errorRedirect, parseAuthorizeParams } from "@/server/oauth/core";
import { isSameOrigin, verifyConsent } from "@/server/oauth/consent";
import { oauthService, originOf } from "@/server/oauth/service";
import { SESSION_COOKIE } from "@/server/session";

export const dynamic = "force-dynamic";

const page = (status: number, msg: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>Authorization failed</title><p>${msg}</p>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });

const see = (location: string) => new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store" } });

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Consent decision (form POST from /oauth/authorize). CSRF: session-bound HMAC ticket + same-origin check. */
export async function POST(req: Request) {
  const origin = originOf(req);
  if (!isSameOrigin(req, origin)) return page(403, "Cross-site request rejected.");
  const sessionToken = cookie(req, SESSION_COOKIE);
  const me = sessionToken ? await customerForSessionToken(sessionToken) : null;
  if (!sessionToken || !me) return page(401, "Your session expired. Start the connection again from your coding agent.");

  const form = new URLSearchParams(await req.text());
  const ticket = verifyConsent(sessionToken, form.get("ticket") ?? "", me.id);
  if (!ticket) return page(400, "This approval form expired or is invalid. Start the connection again from your coding agent.");

  const service = oauthService(origin);
  const v = await service.validateAuthorize(parseAuthorizeParams(new URLSearchParams(ticket.q)));
  if (!v.ok) return v.redirect ? see(v.redirectTo) : page(400, "Invalid authorization request.");

  if (form.get("decision") !== "allow") {
    return see(errorRedirect(v.req.redirectUri, "access_denied", "The user denied the request", v.req.state));
  }
  return see(await service.issueCode(v.req, me.id));
}

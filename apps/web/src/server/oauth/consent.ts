/**
 * CSRF protection for the consent POST. The consent page embeds a ticket = payload.HMAC(session, payload).
 * The HMAC key is the raw session cookie value, which a cross-site attacker cannot read, so a forged
 * POST cannot carry a valid ticket. The payload pins the exact authorization request that was shown.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const CONSENT_TTL_MS = 10 * 60_000;

export interface ConsentPayload { q: string; cid: string; exp: number }

const mac = (key: string, data: string) => createHmac("sha256", `ae-oauth-consent:${key}`).update(data).digest("base64url");

export function signConsent(sessionToken: string, query: string, customerId: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ q: query, cid: customerId, exp: now + CONSENT_TTL_MS } satisfies ConsentPayload)).toString("base64url");
  return `${body}.${mac(sessionToken, body)}`;
}

export function verifyConsent(sessionToken: string, ticket: string, customerId: string, now = Date.now()): ConsentPayload | null {
  if (typeof ticket !== "string" || ticket.length > 8000) return null;
  const [body, sig] = ticket.split(".");
  if (!body || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(mac(sessionToken, body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ConsentPayload;
    if (typeof p.q !== "string" || p.cid !== customerId || typeof p.exp !== "number" || p.exp < now) return null;
    return p;
  } catch { return null; }
}

/** Same-origin check for the consent POST (defence in depth on top of the ticket + SameSite=Lax cookie). */
export function isSameOrigin(req: Request, origin: string): boolean {
  const o = req.headers.get("origin");
  if (o) return o === origin;
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const ref = req.headers.get("referer");
  if (ref) { try { return new URL(ref).origin === origin; } catch { return false; } }
  return true; // non-browser client with no Origin/Referer: the ticket alone authorizes
}

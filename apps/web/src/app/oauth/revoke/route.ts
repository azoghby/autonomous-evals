import { CORS_HEADERS, oauthErrorResponse, oauthService, originOf, parseBasicAuth, readForm, withCors } from "@/server/oauth/service";
import { clientIp, rateLimit } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

/** RFC 7009 token revocation. Revoking a refresh token revokes the whole grant. */
export async function POST(req: Request) {
  const rl = await rateLimit(`oauth-token:${clientIp(req)}`, 60, 600);
  if (!rl.ok) return withCors(Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }));
  try {
    await oauthService(originOf(req)).revoke(await readForm(req), parseBasicAuth(req));
    return withCors(new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } }));
  } catch (e) {
    return withCors(oauthErrorResponse(e));
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

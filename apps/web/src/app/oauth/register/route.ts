import { OAuthError } from "@/server/oauth/core";
import { CORS_HEADERS, jsonNoStore, oauthErrorResponse, oauthService, originOf, withCors } from "@/server/oauth/service";
import { clientIp, rateLimit } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

const REGISTER_LIMIT = 20;
const REGISTER_WINDOW_SEC = 3600;

/** RFC 7591 Dynamic Client Registration (open registration; public clients use PKCE). */
export async function POST(req: Request) {
  const rl = await rateLimit(`oauth-register:${clientIp(req)}`, REGISTER_LIMIT, REGISTER_WINDOW_SEC);
  if (!rl.ok) {
    return withCors(Response.json({ error: "rate_limited", error_description: "Too many registrations" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }));
  }
  try {
    const text = await req.text();
    if (text.length > 20_000) throw new OAuthError("invalid_client_metadata", "Body too large");
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new OAuthError("invalid_client_metadata", "Body must be JSON"); }
    const client = await oauthService(originOf(req)).registerClient(body);
    return withCors(jsonNoStore(client, 201));
  } catch (e) {
    return withCors(oauthErrorResponse(e));
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

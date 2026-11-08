import { CORS_HEADERS, jsonNoStore, oauthErrorResponse, oauthService, originOf, parseBasicAuth, readForm, withCors } from "@/server/oauth/service";
import { clientIp, rateLimit } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

const TOKEN_LIMIT = 60;
const TOKEN_WINDOW_SEC = 600;

/** Token endpoint: authorization_code (PKCE S256) and refresh_token (rotating). */
export async function POST(req: Request) {
  const rl = await rateLimit(`oauth-token:${clientIp(req)}`, TOKEN_LIMIT, TOKEN_WINDOW_SEC);
  if (!rl.ok) {
    return withCors(Response.json({ error: "rate_limited", error_description: "Too many token requests" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } }));
  }
  try {
    const form = await readForm(req);
    const tokens = await oauthService(originOf(req)).token(form, parseBasicAuth(req));
    return withCors(jsonNoStore(tokens));
  } catch (e) {
    return withCors(oauthErrorResponse(e));
  }
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

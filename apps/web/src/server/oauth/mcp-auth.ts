import "server-only";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { verifyApiKey } from "@/server/api-keys";
import { ACCESS_PREFIX, OAUTH_SCOPE, type OAuthService } from "./core";
import { oauthService, originOf } from "./service";
import { withMcpAuth } from "mcp-handler";

export interface McpAuthDeps {
  verifyApiKey: (bearer: string) => Promise<{ keyId: string; customerId: string; email: string } | null>;
  service: (req: Request) => Pick<OAuthService, "verifyAccessToken">;
}

const defaultDeps: McpAuthDeps = { verifyApiKey, service: (req) => oauthService(originOf(req)) };

/** Bearer → AuthInfo for withMcpAuth. Undefined means 401 + WWW-Authenticate (resource_metadata). */
export async function authenticateMcpBearer(req: Request, bearer: string | undefined, deps: McpAuthDeps = defaultDeps): Promise<AuthInfo | undefined> {
  if (!bearer || bearer.length > 512) return undefined;
  if (bearer.startsWith(ACCESS_PREFIX)) {
    const t = await deps.service(req).verifyAccessToken(bearer);
    if (!t || !t.scopes.includes(OAUTH_SCOPE)) return undefined;
    return {
      token: bearer, clientId: `oauth:${t.grantId}`, scopes: t.scopes, expiresAt: t.expiresAt,
      extra: { customerId: t.customerId, email: t.email, via: "oauth", oauthClientId: t.clientId },
    };
  }
  const key = await deps.verifyApiKey(bearer);
  if (!key) return undefined;
  return { token: bearer, clientId: key.keyId, scopes: [OAUTH_SCOPE], extra: { customerId: key.customerId, email: key.email, via: "api_key" } };
}

/** Bearer token from an Authorization header (same parsing as mcp-handler). */
const bearerOf = (req: Request): string | undefined => {
  const [type, token] = req.headers.get("authorization")?.split(" ") ?? [];
  return type?.toLowerCase() === "bearer" && token ? token : undefined;
};

/**
 * withMcpAuth, except a bearer that is present but invalid gets `error="invalid_token", "Invalid token"` instead of
 * mcp-handler's "No authorization provided" (which made clients think they had sent nothing). Verifies once per request.
 */
export function withMcpBearerAuth(
  handler: (req: Request) => Promise<Response>,
  verify: (req: Request, bearer: string | undefined) => Promise<AuthInfo | undefined>,
  opts: { resourceMetadataPath: string },
): (req: Request) => Promise<Response> {
  const verified = new WeakMap<Request, AuthInfo>();
  const inner = withMcpAuth(handler, async (req) => verified.get(req), { required: true, resourceMetadataPath: opts.resourceMetadataPath });
  return async (req) => {
    const bearer = bearerOf(req);
    if (bearer) {
      const info = await verify(req, bearer);
      if (!info) {
        const meta = `${originOf(req)}${opts.resourceMetadataPath}`;
        return Response.json({ error: "invalid_token", error_description: "Invalid token" }, {
          status: 401,
          headers: { "WWW-Authenticate": `Bearer error="invalid_token", error_description="Invalid token", resource_metadata="${meta}"`, "Cache-Control": "no-store" },
        });
      }
      verified.set(req, info);
    }
    return inner(req);
  };
}

import "server-only";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { verifyApiKey } from "@/server/api-keys";
import { ACCESS_PREFIX, OAUTH_SCOPE, type OAuthService } from "./core";
import { oauthService, originOf } from "./service";

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

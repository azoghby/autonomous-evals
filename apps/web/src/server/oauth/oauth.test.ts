import { describe, expect, it, vi } from "vitest";
import { withMcpAuth } from "mcp-handler";
import {
  OAuthMetadataSchema, OAuthProtectedResourceMetadataSchema, OAuthClientInformationFullSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  MCP_PATH, MemoryOAuthStore, OAuthError, OAuthService, PRM_PATH, authorizationServerMetadata, isAllowedRedirectUri,
  parseAuthorizeParams, pkceChallengeS256, protectedResourceMetadata, redirectUriMatches, verifyPkce, CODE_TTL_MS,
} from "./core";
import { signConsent, verifyConsent, isSameOrigin } from "./consent";
import { authenticateMcpBearer } from "./mcp-auth";

const ISSUER = "https://evals.example";
const RESOURCE = `${ISSUER}${MCP_PATH}`;
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const VERIFIER = "v".repeat(20) + "-._~" + "abcDEF0123456789xyzXYZ"; // 46 chars, RFC 7636 charset
const REDIRECT = "http://127.0.0.1:33418/callback";

function setup(now = { t: Date.parse("2026-11-07T12:00:00Z") }) {
  const store = new MemoryOAuthStore(() => "dev@example.com");
  const svc = new OAuthService({ store, issuer: ISSUER, resource: RESOURCE, now: () => new Date(now.t) });
  return { store, svc, now };
}

async function authorize(svc: OAuthService, clientId: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkceChallengeS256(VERIFIER),
    code_challenge_method: "S256", state: "st-123", scope: "mcp", resource: RESOURCE, ...extra,
  });
  const v = await svc.validateAuthorize(parseAuthorizeParams(q));
  if (!v.ok) throw new Error(`authorize failed: ${JSON.stringify(v)}`);
  const loc = new URL(await svc.issueCode(v.req, CUSTOMER));
  return { code: loc.searchParams.get("code")!, loc };
}

const tokenForm = (o: Record<string, string>) => new URLSearchParams(o);
const codeForm = (clientId: string, code: string, verifier = VERIFIER) => tokenForm({
  grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT, resource: RESOURCE,
});

async function expectOAuthError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof OAuthError && e.code === code);
}

describe("metadata documents", () => {
  it("AS metadata validates against the MCP SDK schema and advertises PKCE S256 + DCR", () => {
    const m = OAuthMetadataSchema.parse(authorizationServerMetadata(ISSUER));
    expect(m.issuer).toBe(ISSUER);
    expect(m.code_challenge_methods_supported).toEqual(["S256"]);
    expect(m.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
    expect(m.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(m.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(m.grant_types_supported).toContain("refresh_token");
  });

  it("protected resource metadata names the MCP resource and this AS", () => {
    const m = OAuthProtectedResourceMetadataSchema.parse(protectedResourceMetadata(ISSUER, RESOURCE));
    expect(m.resource).toBe(RESOURCE);
    expect(m.authorization_servers).toEqual([ISSUER]);
    expect(PRM_PATH).toBe("/.well-known/oauth-protected-resource/api/mcp/mcp");
  });
});

describe("redirect URI policy", () => {
  it.each([
    "https://app.example.com/cb", "http://localhost:6274/oauth/callback", "http://127.0.0.1:33418/callback", "http://localhost/cb", "http://[::1]:8080/cb",
  ])("allows %s", (u) => expect(isAllowedRedirectUri(u)).toBe(true));

  it.each([
    "http://evil.example/cb", "http://localhost.evil.com/cb", "http://127.0.0.2/cb", "javascript:alert(1)", "cursor://callback",
    "data:text/html,x", "https://app.example.com/cb#frag", "https://user:pw@app.example.com/cb", "not a url", "",
  ])("rejects %s", (u) => expect(isAllowedRedirectUri(u)).toBe(false));

  it("matches exactly, except the port of loopback redirects (RFC 8252)", () => {
    expect(redirectUriMatches(["https://a.example/cb"], "https://a.example/cb")).toBe(true);
    expect(redirectUriMatches(["https://a.example/cb"], "https://a.example/cb/")).toBe(false);
    expect(redirectUriMatches(["https://a.example/cb"], "https://a.example/cb?x=1")).toBe(false);
    expect(redirectUriMatches(["https://a.example:443/cb"], "https://a.example:8443/cb")).toBe(false);
    expect(redirectUriMatches(["http://127.0.0.1:1000/callback"], "http://127.0.0.1:2000/callback")).toBe(true);
    expect(redirectUriMatches(["http://127.0.0.1:1000/callback"], "http://localhost:1000/callback")).toBe(false);
    expect(redirectUriMatches(["http://127.0.0.1:1000/callback"], "http://127.0.0.1:1000/other")).toBe(false);
  });
});

describe("dynamic client registration", () => {
  it("registers a public client with SDK-compatible output", async () => {
    const { svc, store } = setup();
    const c = await svc.registerClient({ client_name: "Claude Code", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    OAuthClientInformationFullSchema.parse(c);
    expect(c.client_id).toMatch(/^aeoc_/);
    expect(c.client_secret).toBeUndefined();
    expect(c.token_endpoint_auth_method).toBe("none");
    expect((await store.getClient(c.client_id))?.clientName).toBe("Claude Code");
  });

  it("issues a secret only for confidential methods and stores only its hash", async () => {
    const { svc, store } = setup();
    const c = await svc.registerClient({ redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_post" });
    expect(c.client_secret).toMatch(/^aeo_cs_/);
    const rec = await store.getClient(c.client_id);
    expect(rec?.clientSecretHash).toHaveLength(64);
    expect(JSON.stringify(rec)).not.toContain(c.client_secret!);
  });

  it.each([
    [{ redirect_uris: [] }, "invalid_client_metadata"],
    [{}, "invalid_client_metadata"],
    [{ redirect_uris: ["http://evil.example/cb"] }, "invalid_redirect_uri"],
    [{ redirect_uris: ["myapp://cb"] }, "invalid_redirect_uri"],
    [{ redirect_uris: [REDIRECT], grant_types: ["client_credentials"] }, "invalid_client_metadata"],
    [{ redirect_uris: [REDIRECT], response_types: ["token"] }, "invalid_client_metadata"],
    [{ redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt" }, "invalid_client_metadata"],
    [{ redirect_uris: [REDIRECT], scope: "admin" }, "invalid_client_metadata"],
  ])("rejects %j", async (body, code) => {
    const { svc } = setup();
    await expectOAuthError(svc.registerClient(body), code);
  });
});

describe("authorize validation", () => {
  it("does not redirect for unknown client or unregistered redirect_uri", async () => {
    const { svc } = setup();
    const c = await svc.registerClient({ redirect_uris: [REDIRECT] });
    const bad1 = await svc.validateAuthorize(parseAuthorizeParams(new URLSearchParams({ client_id: "nope", redirect_uri: REDIRECT })));
    expect(bad1).toMatchObject({ ok: false, redirect: false });
    const bad2 = await svc.validateAuthorize(parseAuthorizeParams(new URLSearchParams({ client_id: c.client_id, redirect_uri: "https://evil.example/cb", response_type: "code" })));
    expect(bad2).toMatchObject({ ok: false, redirect: false });
  });

  it("requires PKCE S256 (plain or missing is redirected back as invalid_request with state)", async () => {
    const { svc } = setup();
    const c = await svc.registerClient({ redirect_uris: [REDIRECT] });
    for (const extra of [{}, { code_challenge: pkceChallengeS256(VERIFIER), code_challenge_method: "plain" }]) {
      const v = await svc.validateAuthorize(parseAuthorizeParams(new URLSearchParams({ client_id: c.client_id, redirect_uri: REDIRECT, response_type: "code", state: "s1", ...extra })));
      expect(v.ok).toBe(false);
      if (!v.ok && v.redirect) {
        const u = new URL(v.redirectTo);
        expect(u.searchParams.get("error")).toBe("invalid_request");
        expect(u.searchParams.get("state")).toBe("s1");
      } else throw new Error("expected redirect error");
    }
  });

  it("rejects a foreign resource indicator", async () => {
    const { svc } = setup();
    const c = await svc.registerClient({ redirect_uris: [REDIRECT] });
    await expect(authorize(svc, c.client_id, { resource: "https://other.example/mcp" })).rejects.toThrow(/invalid_target/);
  });

  it("returns code, state and iss on the redirect", async () => {
    const { svc } = setup();
    const c = await svc.registerClient({ redirect_uris: [REDIRECT] });
    const { loc } = await authorize(svc, c.client_id);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get("state")).toBe("st-123");
    expect(loc.searchParams.get("iss")).toBe(ISSUER);
    expect(loc.searchParams.get("code")).toMatch(/^aeo_c_/);
  });
});

describe("PKCE", () => {
  it("verifies S256 and rejects wrong or malformed verifiers", () => {
    const ch = pkceChallengeS256(VERIFIER);
    expect(verifyPkce(VERIFIER, ch)).toBe(true);
    expect(verifyPkce(VERIFIER + "x", ch)).toBe(false);
    expect(verifyPkce("short", pkceChallengeS256("short"))).toBe(false);
    // RFC 7636 appendix B test vector
    expect(pkceChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("token exchange fails with a wrong code_verifier", async () => {
    const { svc } = setup();
    const c = await svc.registerClient({ redirect_uris: [REDIRECT] });
    const { code } = await authorize(svc, c.client_id);
    await expectOAuthError(svc.token(codeForm(c.client_id, code, "w".repeat(43))), "invalid_grant");
  });
});

describe("token endpoint", () => {
  it("exchanges a code once; a replay is rejected and revokes the issued tokens", async () => {
    const { svc, store } = setup();
    const c = await svc.registerClient({ redirect_uris: [REDIRECT] });
    const { code } = await authorize(svc, c.client_id);
    const t = await svc.token(codeForm(c.client_id, code));
    expect(t.access_token).toMatch(/^aeo_at_/);
    expect(t.refresh_token).toMatch(/^aeo_rt_/);
    expect(t.token_type).toBe("Bearer");
    expect(await svc.verifyAccessToken(t.access_token)).toMatchObject({ customerId: CUSTOMER, email: "dev@example.com", scopes: ["mcp"] });
    // stored hashed only
    expect([...store.tokens.keys()].some((k) => k === t.access_token)).toBe(false);
    expect(JSON.stringify([...store.tokens.values()])).not.toContain(t.access_token);

    await expectOAuthError(svc.token(codeForm(c.client_id, code)), "invalid_grant");
    expect(await svc.verifyAccessToken(t.access_token)).toBeNull();
  });

  it("rejects an expired code (60 s TTL)", async () => {
    const { svc, now } = setup();
    const c = await svc.registerClient({ redirect_uris: [REDIRECT] });
    const { code } = await authorize(svc, c.client_id);
    now.t += CODE_TTL_MS + 1;
    await expectOAuthError(svc.token(codeForm(c.client_id, code)), "invalid_grant");
  });

  it("rejects redirect_uri mismatch and codes presented by another client", async () => {
    const { svc } = setup();
    const a = await svc.registerClient({ redirect_uris: [REDIRECT] });
    const b = await svc.registerClient({ redirect_uris: [REDIRECT] });
    const { code } = await authorize(svc, a.client_id);
    await expectOAuthError(svc.token(codeForm(b.client_id, code)), "invalid_grant");
    const { code: code2 } = await authorize(svc, a.client_id);
    const f = codeForm(a.client_id, code2); f.set("redirect_uri", "http://127.0.0.1:1/other");
    await expectOAuthError(svc.token(f), "invalid_grant");
  });

  it("requires the secret for confidential clients", async () => {
    const { svc } = setup();
    const c = await svc.registerClient({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" });
    const { code } = await authorize(svc, c.client_id);
    await expectOAuthError(svc.token(codeForm(c.client_id, code)), "invalid_client");
    const { code: code2 } = await authorize(svc, c.client_id);
    const t = await svc.token(codeForm(c.client_id, code2), { id: c.client_id, secret: c.client_secret! });
    expect(t.access_token).toMatch(/^aeo_at_/);
  });

  it("rotates refresh tokens; reusing an old one revokes the grant", async () => {
    const { svc } = setup();
    const c = await svc.registerClient({ redirect_uris: [REDIRECT] });
    const { code } = await authorize(svc, c.client_id);
    const t1 = await svc.token(codeForm(c.client_id, code));
    const t2 = await svc.token(tokenForm({ grant_type: "refresh_token", client_id: c.client_id, refresh_token: t1.refresh_token }));
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect(await svc.verifyAccessToken(t2.access_token)).not.toBeNull();
    await expectOAuthError(svc.token(tokenForm({ grant_type: "refresh_token", client_id: c.client_id, refresh_token: t1.refresh_token })), "invalid_grant");
    expect(await svc.verifyAccessToken(t2.access_token)).toBeNull();
    await expectOAuthError(svc.token(tokenForm({ grant_type: "refresh_token", client_id: c.client_id, refresh_token: t2.refresh_token })), "invalid_grant");
  });

  it("access tokens expire and can be revoked (RFC 7009 + per-customer grant revoke)", async () => {
    const { svc, now } = setup();
    const c = await svc.registerClient({ redirect_uris: [REDIRECT] });
    const t = await svc.token(codeForm(c.client_id, (await authorize(svc, c.client_id)).code));
    const grants = await svc.listGrants(CUSTOMER);
    expect(grants).toHaveLength(1);
    expect(await svc.revokeGrantForCustomer("22222222-2222-4222-8222-222222222222", grants[0].grantId)).toBe(false);
    await svc.revoke(tokenForm({ client_id: c.client_id, token: t.refresh_token }));
    expect(await svc.verifyAccessToken(t.access_token)).toBeNull();

    const t2 = await svc.token(codeForm(c.client_id, (await authorize(svc, c.client_id)).code));
    now.t += 60 * 60_000 + 1;
    expect(await svc.verifyAccessToken(t2.access_token)).toBeNull();
  });

  it("rejects unsupported grant types", async () => {
    const { svc } = setup();
    const c = await svc.registerClient({ redirect_uris: [REDIRECT] });
    await expectOAuthError(svc.token(tokenForm({ grant_type: "password", client_id: c.client_id })), "unsupported_grant_type");
  });
});

describe("consent CSRF ticket", () => {
  it("binds to the session and customer, and expires", () => {
    const t = signConsent("session-A", "client_id=x", CUSTOMER, 1000);
    expect(verifyConsent("session-A", t, CUSTOMER, 2000)?.q).toBe("client_id=x");
    expect(verifyConsent("session-B", t, CUSTOMER, 2000)).toBeNull();
    expect(verifyConsent("session-A", t, "22222222-2222-4222-8222-222222222222", 2000)).toBeNull();
    expect(verifyConsent("session-A", t, CUSTOMER, 1000 + 11 * 60_000)).toBeNull();
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ q: "client_id=evil", cid: CUSTOMER, exp: 9e15 })).toString("base64url");
    expect(verifyConsent("session-A", `${forged}.${sig}`, CUSTOMER, 2000)).toBeNull();
    expect(body).toBeTruthy();
  });

  it("rejects cross-site POSTs", () => {
    const mk = (h: Record<string, string>) => new Request("https://evals.example/oauth/authorize/decision", { method: "POST", headers: h });
    expect(isSameOrigin(mk({ origin: "https://evals.example" }), ISSUER)).toBe(true);
    expect(isSameOrigin(mk({ origin: "https://evil.example" }), ISSUER)).toBe(false);
    expect(isSameOrigin(mk({ "sec-fetch-site": "cross-site" }), ISSUER)).toBe(false);
  });
});

describe("MCP route bearer auth", () => {
  async function wired() {
    // withMcpAuth checks expiresAt against the real clock.
    const { svc } = setup({ t: Date.now() });
    const apiKey = vi.fn(async (b: string) => (b === "ae_test_key" ? { keyId: "k1", customerId: "c-key", email: "key@example.com" } : null));
    const handler = vi.fn(async (req: Request) => Response.json({ auth: (req as Request & { auth?: unknown }).auth }));
    const route = withMcpAuth(handler, (req, bearer) => authenticateMcpBearer(req, bearer, { verifyApiKey: apiKey, service: () => svc }), { required: true, resourceMetadataPath: PRM_PATH });
    const call = (token?: string) => route(new Request(`${ISSUER}${MCP_PATH}`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} }));
    return { svc, call, handler };
  }

  it("401 without a token carries WWW-Authenticate with the path-suffixed resource_metadata URL", async () => {
    const { call, handler } = await wired();
    const res = await call();
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate") ?? "";
    expect(www).toMatch(/^Bearer /);
    expect(www).toContain(`resource_metadata="${ISSUER}${PRM_PATH}"`);
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts OAuth access tokens bound to the customer, and still accepts ae_ API keys", async () => {
    const { svc, call } = await wired();
    const c = await svc.registerClient({ redirect_uris: [REDIRECT] });
    const t = await svc.token(codeForm(c.client_id, (await authorize(svc, c.client_id)).code));
    const r1 = await call(t.access_token);
    expect(r1.status).toBe(200);
    expect((await r1.json()).auth.extra).toMatchObject({ customerId: CUSTOMER, email: "dev@example.com", via: "oauth" });
    const r2 = await call("ae_test_key");
    expect(r2.status).toBe(200);
    expect((await r2.json()).auth.extra).toMatchObject({ customerId: "c-key", via: "api_key" });
  });

  it("rejects revoked, unknown and refresh tokens", async () => {
    const { svc, call } = await wired();
    const c = await svc.registerClient({ redirect_uris: [REDIRECT] });
    const t = await svc.token(codeForm(c.client_id, (await authorize(svc, c.client_id)).code));
    expect((await call(t.refresh_token)).status).toBe(401);
    expect((await call("aeo_at_bogus")).status).toBe(401);
    await svc.revoke(tokenForm({ client_id: c.client_id, token: t.access_token }));
    expect((await call(t.access_token)).status).toBe(401);
  });
});

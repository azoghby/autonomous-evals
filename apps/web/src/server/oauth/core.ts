/**
 * MCP OAuth 2.1 authorization server core: pure logic behind a storage interface so tests use the
 * in-memory store and production uses Postgres (./db-store.ts). No framework imports here.
 *
 * Spec points (MCP authorization, SDK 1.32): PKCE S256 mandatory, RFC 8707 `resource`, RFC 7591 DCR,
 * RFC 9728 protected resource metadata, RFC 8414 AS metadata, refresh token rotation for public clients.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const OAUTH_SCOPE = "mcp";
export const SUPPORTED_SCOPES = [OAUTH_SCOPE] as const;
export const CODE_TTL_MS = 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;

export const ACCESS_PREFIX = "aeo_at_";
export const REFRESH_PREFIX = "aeo_rt_";
const CODE_PREFIX = "aeo_c_";
const CLIENT_PREFIX = "aeoc_";
const SECRET_PREFIX = "aeo_cs_";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const rand = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

export class OAuthError extends Error {
  constructor(public readonly code: string, public readonly description: string, public readonly status = 400) {
    super(description);
  }
  toJSON(): { error: string; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}

// ─── Redirect URI policy ────────────────────────────────────────────────────────────────────────

/**
 * Allowed: https (any host), and http only on loopback (localhost / 127.0.0.1 / [::1], any port).
 * Rejected: other schemes (custom schemes, javascript:, data:), fragments, userinfo, non-loopback http.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash || raw.includes("#")) return false;
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return u.hostname.length > 0;
  if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  return false;
}

const isLoopback = (u: URL) => u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);

/**
 * Exact string match against a registered URI, with the RFC 8252 §7.3 exception: for loopback
 * redirects the port may differ (native apps bind an ephemeral port). Scheme, host, path, query exact.
 */
export function redirectUriMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try { req = new URL(requested); } catch { return false; }
  if (!isLoopback(req)) return false;
  return registered.some((r) => {
    try {
      const reg = new URL(r);
      return isLoopback(reg) && reg.hostname === req.hostname && reg.pathname === req.pathname && reg.search === req.search;
    } catch { return false; }
  });
}

// ─── PKCE ───────────────────────────────────────────────────────────────────────────────────────

const PKCE_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
export const isValidCodeChallenge = (c: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(c);

export function pkceChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!PKCE_RE.test(verifier)) return false;
  const a = Buffer.from(pkceChallengeS256(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── Dynamic Client Registration (RFC 7591) ─────────────────────────────────────────────────────

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;

export const ClientRegistrationRequest = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().trim().min(1).max(100).optional(),
  client_uri: z.string().max(2000).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).max(5).optional(),
  response_types: z.array(z.string()).max(5).optional(),
  scope: z.string().max(200).optional(),
  software_id: z.string().max(200).optional(),
  software_version: z.string().max(100).optional(),
}).passthrough();

export interface OAuthClientRecord {
  id: string;
  clientName: string;
  clientUri: string | null;
  redirectUris: string[];
  grantTypes: string[];
  tokenEndpointAuthMethod: (typeof AUTH_METHODS)[number];
  clientSecretHash: string | null;
  scope: string;
  softwareId: string | null;
  softwareVersion: string | null;
  createdAt: Date;
}

export interface CodeRecord {
  codeHash: string; clientId: string; customerId: string; grantId: string; redirectUri: string;
  codeChallenge: string; scope: string; resource: string | null; expiresAt: Date; usedAt: Date | null;
}

export interface TokenRecord {
  tokenHash: string; kind: "access" | "refresh"; grantId: string; clientId: string; customerId: string;
  scope: string; resource: string | null; expiresAt: Date; revokedAt: Date | null;
}

export interface GrantSummary { grantId: string; clientId: string; clientName: string; scope: string; createdAt: Date; lastUsedAt: Date | null }

/** Persistence boundary. All "claim" methods must be atomic (single conditional UPDATE in SQL). */
export interface OAuthStore {
  insertClient(c: OAuthClientRecord): Promise<void>;
  getClient(id: string): Promise<OAuthClientRecord | null>;
  insertCode(c: CodeRecord): Promise<void>;
  /** Atomically mark the code used. Returns the row if THIS call claimed it; `{reused}` if it was already used. */
  claimCode(codeHash: string, now: Date): Promise<{ row: CodeRecord } | { reused: CodeRecord } | null>;
  insertTokens(t: TokenRecord[]): Promise<void>;
  /** Live (unrevoked) token by hash plus the owner's email. Expiry is checked by the caller. */
  findToken(tokenHash: string): Promise<(TokenRecord & { email: string }) | null>;
  /** Atomically revoke a live refresh token. Returns it if THIS call revoked it; `{reused}` if already revoked. */
  claimRefresh(tokenHash: string, now: Date): Promise<{ row: TokenRecord } | { reused: TokenRecord } | null>;
  revokeToken(tokenHash: string, now: Date): Promise<TokenRecord | null>;
  revokeGrant(grantId: string, now: Date, customerId?: string): Promise<number>;
  listGrants(customerId: string): Promise<GrantSummary[]>;
  touchToken?(tokenHash: string, now: Date): Promise<void>;
}

export interface RegisteredClient {
  client_id: string; client_id_issued_at: number; client_secret?: string; client_secret_expires_at?: number;
  client_name: string; client_uri?: string; redirect_uris: string[]; grant_types: string[]; response_types: string[];
  token_endpoint_auth_method: string; scope: string; software_id?: string; software_version?: string;
}

export interface TokenResponse { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string }

export interface AuthorizeParams {
  responseType: string | null; clientId: string | null; redirectUri: string | null; codeChallenge: string | null;
  codeChallengeMethod: string | null; state: string | null; scope: string | null; resource: string | null;
}

/** A validated authorization request, safe to render on the consent screen. */
export interface ValidatedAuthorize {
  client: OAuthClientRecord; redirectUri: string; codeChallenge: string; state: string | null; scope: string; resource: string | null;
}

export type AuthorizeValidation =
  | { ok: true; req: ValidatedAuthorize }
  /** Errors that must NOT redirect (unknown client / bad redirect_uri): show an error page. */
  | { ok: false; redirect: false; error: OAuthError }
  /** Errors reported to the client via redirect (RFC 6749 §4.1.2.1). */
  | { ok: false; redirect: true; redirectTo: string };

export function parseAuthorizeParams(sp: URLSearchParams): AuthorizeParams {
  return {
    responseType: sp.get("response_type"), clientId: sp.get("client_id"), redirectUri: sp.get("redirect_uri"),
    codeChallenge: sp.get("code_challenge"), codeChallengeMethod: sp.get("code_challenge_method"),
    state: sp.get("state"), scope: sp.get("scope"), resource: sp.get("resource"),
  };
}

export function errorRedirect(redirectUri: string, error: string, description: string, state: string | null): string {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  return u.toString();
}

export interface OAuthServiceOptions { store: OAuthStore; now?: () => Date; issuer: string; resource: string }

export class OAuthService {
  private readonly store: OAuthStore;
  private readonly now: () => Date;
  readonly issuer: string;
  /** Canonical MCP resource URL (RFC 8707). Tokens are audience-bound to it. */
  readonly resource: string;

  constructor(o: OAuthServiceOptions) {
    this.store = o.store;
    this.now = o.now ?? (() => new Date());
    this.issuer = o.issuer.replace(/\/$/, "");
    this.resource = o.resource;
  }

  // ── DCR ──
  async registerClient(body: unknown): Promise<RegisteredClient> {
    const parsed = ClientRegistrationRequest.safeParse(body);
    if (!parsed.success) throw new OAuthError("invalid_client_metadata", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const m = parsed.data;
    for (const uri of m.redirect_uris) {
      if (!isAllowedRedirectUri(uri)) {
        throw new OAuthError("invalid_redirect_uri", `redirect_uri not allowed: only https or http loopback (localhost/127.0.0.1) without fragments are accepted`);
      }
    }
    const method = m.token_endpoint_auth_method ?? "none";
    if (!(AUTH_METHODS as readonly string[]).includes(method)) throw new OAuthError("invalid_client_metadata", `unsupported token_endpoint_auth_method: ${method}`);
    const grantTypes = m.grant_types ?? ["authorization_code", "refresh_token"];
    if (!grantTypes.includes("authorization_code") || grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
      throw new OAuthError("invalid_client_metadata", "grant_types must include authorization_code and may include refresh_token only");
    }
    const responseTypes = m.response_types ?? ["code"];
    if (responseTypes.some((r) => r !== "code")) throw new OAuthError("invalid_client_metadata", "response_types must be [\"code\"]");
    const scope = this.normalizeScope(m.scope ?? OAUTH_SCOPE, "invalid_client_metadata");
    if (m.client_uri && !/^https:\/\//.test(m.client_uri)) throw new OAuthError("invalid_client_metadata", "client_uri must be https");

    const createdAt = this.now();
    const secret = method === "none" ? undefined : rand(SECRET_PREFIX);
    const rec: OAuthClientRecord = {
      id: rand(CLIENT_PREFIX).slice(0, CLIENT_PREFIX.length + 32),
      clientName: (m.client_name ?? "MCP client").replace(/[\u0000-\u001f\u007f]/g, ""),
      clientUri: m.client_uri ?? null,
      redirectUris: [...m.redirect_uris],
      grantTypes,
      tokenEndpointAuthMethod: method as OAuthClientRecord["tokenEndpointAuthMethod"],
      clientSecretHash: secret ? sha256(secret) : null,
      scope,
      softwareId: m.software_id ?? null,
      softwareVersion: m.software_version ?? null,
      createdAt,
    };
    await this.store.insertClient(rec);
    return {
      client_id: rec.id,
      client_id_issued_at: Math.floor(createdAt.getTime() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: rec.clientName,
      ...(rec.clientUri ? { client_uri: rec.clientUri } : {}),
      redirect_uris: rec.redirectUris,
      grant_types: rec.grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: rec.tokenEndpointAuthMethod,
      scope: rec.scope,
      ...(rec.softwareId ? { software_id: rec.softwareId } : {}),
      ...(rec.softwareVersion ? { software_version: rec.softwareVersion } : {}),
    };
  }

  private normalizeScope(raw: string | null | undefined, errCode = "invalid_scope"): string {
    const parts = (raw ?? "").split(/\s+/).filter(Boolean);
    if (parts.length === 0) return OAUTH_SCOPE;
    const bad = parts.filter((p) => !(SUPPORTED_SCOPES as readonly string[]).includes(p));
    if (bad.length) throw new OAuthError(errCode, `unsupported scope: ${bad.join(" ")}`);
    return [...new Set(parts)].join(" ");
  }

  /** Accept the canonical resource, with or without trailing slash; anything else is invalid_target. */
  private checkResource(resource: string | null): string | null {
    if (!resource) return null;
    const norm = (s: string) => s.replace(/\/$/, "");
    if (norm(resource) !== norm(this.resource)) throw new OAuthError("invalid_target", `resource must be ${this.resource}`);
    return this.resource;
  }

  // ── /authorize ──
  async validateAuthorize(p: AuthorizeParams): Promise<AuthorizeValidation> {
    if (!p.clientId) return { ok: false, redirect: false, error: new OAuthError("invalid_request", "client_id is required") };
    const client = await this.store.getClient(p.clientId);
    if (!client) return { ok: false, redirect: false, error: new OAuthError("invalid_client", "Unknown client_id. Re-register the client.") };
    if (!p.redirectUri || !redirectUriMatches(client.redirectUris, p.redirectUri)) {
      return { ok: false, redirect: false, error: new OAuthError("invalid_request", "redirect_uri does not match a registered redirect URI") };
    }
    const fail = (code: string, desc: string): AuthorizeValidation => ({ ok: false, redirect: true, redirectTo: errorRedirect(p.redirectUri!, code, desc, p.state) });
    if (p.responseType !== "code") return fail("unsupported_response_type", "response_type must be code");
    if (!p.codeChallenge || p.codeChallengeMethod !== "S256") return fail("invalid_request", "PKCE is required: code_challenge with code_challenge_method=S256");
    if (!isValidCodeChallenge(p.codeChallenge)) return fail("invalid_request", "code_challenge must be a base64url SHA-256 (43 chars)");
    if (p.state && p.state.length > 1000) return fail("invalid_request", "state too long");
    let scope: string, resource: string | null;
    try {
      scope = this.normalizeScope(p.scope);
      resource = this.checkResource(p.resource);
    } catch (e) {
      const err = e as OAuthError;
      return fail(err.code, err.description);
    }
    return { ok: true, req: { client, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge, state: p.state, scope, resource } };
  }

  /** Called after the signed-in customer approved the consent screen. Returns the redirect with ?code&state. */
  async issueCode(req: ValidatedAuthorize, customerId: string): Promise<string> {
    const code = rand(CODE_PREFIX);
    await this.store.insertCode({
      codeHash: sha256(code), clientId: req.client.id, customerId, grantId: randomUUID(), redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge, scope: req.scope, resource: req.resource,
      expiresAt: new Date(this.now().getTime() + CODE_TTL_MS), usedAt: null,
    });
    const u = new URL(req.redirectUri);
    u.searchParams.set("code", code);
    if (req.state) u.searchParams.set("state", req.state);
    u.searchParams.set("iss", this.issuer);
    return u.toString();
  }

  // ── /token ──
  /** Client authentication per its registered method. `basic` = parsed Authorization: Basic header, if any. */
  private async authenticateClient(form: URLSearchParams, basic: { id: string; secret: string } | null): Promise<OAuthClientRecord> {
    const clientId = basic?.id ?? form.get("client_id");
    if (!clientId) throw new OAuthError("invalid_client", "client_id is required", 401);
    const client = await this.store.getClient(clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
    if (client.tokenEndpointAuthMethod === "none") return client;
    const secret = basic?.secret ?? form.get("client_secret");
    if (!secret || !client.clientSecretHash) throw new OAuthError("invalid_client", "Client authentication required", 401);
    const a = Buffer.from(sha256(secret)), b = Buffer.from(client.clientSecretHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new OAuthError("invalid_client", "Invalid client credentials", 401);
    return client;
  }

  async token(form: URLSearchParams, basic: { id: string; secret: string } | null = null): Promise<TokenResponse> {
    const grantType = form.get("grant_type");
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    }
    const client = await this.authenticateClient(form, basic);
    if (!client.grantTypes.includes(grantType)) throw new OAuthError("unauthorized_client", `client is not registered for ${grantType}`);
    return grantType === "authorization_code" ? this.exchangeCode(client, form) : this.refresh(client, form);
  }

  private async exchangeCode(client: OAuthClientRecord, form: URLSearchParams): Promise<TokenResponse> {
    const code = form.get("code"), verifier = form.get("code_verifier"), redirectUri = form.get("redirect_uri");
    if (!code || !verifier) throw new OAuthError("invalid_request", "code and code_verifier are required");
    const now = this.now();
    const claim = await this.store.claimCode(sha256(code), now);
    if (!claim) throw new OAuthError("invalid_grant", "Invalid authorization code");
    if ("reused" in claim) {
      // RFC 6749 §4.1.2: a replayed code revokes every token already issued from it.
      await this.store.revokeGrant(claim.reused.grantId, now);
      throw new OAuthError("invalid_grant", "Authorization code already used");
    }
    const row = claim.row;
    if (row.clientId !== client.id) throw new OAuthError("invalid_grant", "Code was issued to another client");
    if (row.expiresAt.getTime() <= now.getTime()) throw new OAuthError("invalid_grant", "Authorization code expired");
    if (!redirectUri || redirectUri !== row.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match the authorization request");
    if (!verifyPkce(verifier, row.codeChallenge)) throw new OAuthError("invalid_grant", "PKCE verification failed");
    const resource = form.get("resource");
    if (resource && row.resource && this.checkResource(resource) !== row.resource) throw new OAuthError("invalid_target", "resource mismatch");
    return this.mint(client.id, row.customerId, row.grantId, row.scope, row.resource ?? this.checkResource(resource));
  }

  private async refresh(client: OAuthClientRecord, form: URLSearchParams): Promise<TokenResponse> {
    const rt = form.get("refresh_token");
    if (!rt || !rt.startsWith(REFRESH_PREFIX)) throw new OAuthError("invalid_grant", "Invalid refresh token");
    const now = this.now();
    const claim = await this.store.claimRefresh(sha256(rt), now);
    if (!claim) throw new OAuthError("invalid_grant", "Invalid refresh token");
    if ("reused" in claim) {
      // Rotated refresh token replayed: likely stolen. Kill the whole grant (OAuth 2.1 §4.3.1).
      await this.store.revokeGrant(claim.reused.grantId, now);
      throw new OAuthError("invalid_grant", "Refresh token already used; grant revoked");
    }
    const row = claim.row;
    if (row.clientId !== client.id) throw new OAuthError("invalid_grant", "Refresh token was issued to another client");
    if (row.expiresAt.getTime() <= now.getTime()) throw new OAuthError("invalid_grant", "Refresh token expired");
    let scope = row.scope;
    const requested = form.get("scope");
    if (requested) {
      scope = this.normalizeScope(requested);
      if (scope.split(" ").some((s) => !row.scope.split(" ").includes(s))) throw new OAuthError("invalid_scope", "Cannot widen scope on refresh");
    }
    return this.mint(client.id, row.customerId, row.grantId, scope, row.resource);
  }

  private async mint(clientId: string, customerId: string, grantId: string, scope: string, resource: string | null): Promise<TokenResponse> {
    const now = this.now().getTime();
    const access = rand(ACCESS_PREFIX), refresh = rand(REFRESH_PREFIX);
    const base = { grantId, clientId, customerId, scope, resource, revokedAt: null };
    await this.store.insertTokens([
      { ...base, tokenHash: sha256(access), kind: "access", expiresAt: new Date(now + ACCESS_TTL_MS) },
      { ...base, tokenHash: sha256(refresh), kind: "refresh", expiresAt: new Date(now + REFRESH_TTL_MS) },
    ]);
    return { access_token: access, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope };
  }

  // ── Resource server side ──
  /** Verify an access token presented to the MCP route. Null for unknown/expired/revoked/wrong-audience. */
  async verifyAccessToken(token: string): Promise<{ customerId: string; email: string; clientId: string; grantId: string; scopes: string[]; expiresAt: number } | null> {
    if (!token.startsWith(ACCESS_PREFIX)) return null;
    const hash = sha256(token);
    const row = await this.store.findToken(hash);
    if (!row || row.kind !== "access" || row.revokedAt) return null;
    const now = this.now();
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    if (row.resource && row.resource !== this.resource) return null;
    void this.store.touchToken?.(hash, now)?.catch(() => undefined);
    return {
      customerId: row.customerId, email: row.email, clientId: row.clientId, grantId: row.grantId,
      scopes: row.scope.split(" ").filter(Boolean), expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
    };
  }

  /** RFC 7009. Always succeeds from the caller's view; revoking a refresh token kills the whole grant. */
  async revoke(form: URLSearchParams, basic: { id: string; secret: string } | null = null): Promise<void> {
    const client = await this.authenticateClient(form, basic);
    const token = form.get("token");
    if (!token) throw new OAuthError("invalid_request", "token is required");
    const now = this.now();
    const row = await this.store.findToken(sha256(token));
    if (!row || row.clientId !== client.id) return;
    if (row.kind === "refresh") await this.store.revokeGrant(row.grantId, now);
    else await this.store.revokeToken(row.tokenHash, now);
  }

  listGrants(customerId: string): Promise<GrantSummary[]> { return this.store.listGrants(customerId); }
  async revokeGrantForCustomer(customerId: string, grantId: string): Promise<boolean> {
    return (await this.store.revokeGrant(grantId, this.now(), customerId)) > 0;
  }
}

// ─── Metadata documents ─────────────────────────────────────────────────────────────────────────

export function authorizationServerMetadata(issuer: string): Record<string, unknown> {
  const i = issuer.replace(/\/$/, "");
  return {
    issuer: i,
    authorization_endpoint: `${i}/oauth/authorize`,
    token_endpoint: `${i}/oauth/token`,
    registration_endpoint: `${i}/oauth/register`,
    revocation_endpoint: `${i}/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    scopes_supported: [...SUPPORTED_SCOPES],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  };
}

export function protectedResourceMetadata(issuer: string, resource: string): Record<string, unknown> {
  return {
    resource,
    authorization_servers: [issuer.replace(/\/$/, "")],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Standard Evals MCP",
  };
}

export const MCP_PATH = "/api/mcp/mcp";
export const PRM_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;

// ─── In-memory store (tests, and dev before the migration lands) ───────────────────────────────

export class MemoryOAuthStore implements OAuthStore {
  clients = new Map<string, OAuthClientRecord>();
  codes = new Map<string, CodeRecord>();
  tokens = new Map<string, TokenRecord & { lastUsedAt: Date | null; createdAt: Date }>();
  constructor(private readonly emailOf: (customerId: string) => string | Promise<string> = () => "") {}

  async insertClient(c: OAuthClientRecord) { this.clients.set(c.id, { ...c }); }
  async getClient(id: string) { const c = this.clients.get(id); return c ? { ...c } : null; }
  async insertCode(c: CodeRecord) { this.codes.set(c.codeHash, { ...c }); }
  async claimCode(codeHash: string, now: Date) {
    const c = this.codes.get(codeHash);
    if (!c) return null;
    if (c.usedAt) return { reused: { ...c } };
    this.codes.set(codeHash, { ...c, usedAt: now });
    return { row: { ...c } };
  }
  async insertTokens(ts: TokenRecord[]) {
    for (const t of ts) this.tokens.set(t.tokenHash, { ...t, lastUsedAt: null, createdAt: new Date() });
  }
  async findToken(tokenHash: string) {
    const t = this.tokens.get(tokenHash);
    if (!t || t.revokedAt) return null;
    return { ...t, email: await this.emailOf(t.customerId) };
  }
  async claimRefresh(tokenHash: string, now: Date) {
    const t = this.tokens.get(tokenHash);
    if (!t || t.kind !== "refresh") return null;
    if (t.revokedAt) return { reused: { ...t } };
    this.tokens.set(tokenHash, { ...t, revokedAt: now });
    return { row: { ...t } };
  }
  async revokeToken(tokenHash: string, now: Date) {
    const t = this.tokens.get(tokenHash);
    if (!t || t.revokedAt) return null;
    this.tokens.set(tokenHash, { ...t, revokedAt: now });
    return { ...t };
  }
  async revokeGrant(grantId: string, now: Date, customerId?: string) {
    let n = 0;
    for (const [h, t] of this.tokens) {
      if (t.grantId === grantId && !t.revokedAt && (!customerId || t.customerId === customerId)) {
        this.tokens.set(h, { ...t, revokedAt: now }); n++;
      }
    }
    return n;
  }
  async listGrants(customerId: string) {
    const by = new Map<string, GrantSummary>();
    for (const t of this.tokens.values()) {
      if (t.customerId !== customerId || t.revokedAt || t.kind !== "refresh") continue;
      by.set(t.grantId, { grantId: t.grantId, clientId: t.clientId, clientName: this.clients.get(t.clientId)?.clientName ?? t.clientId, scope: t.scope, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt });
    }
    return [...by.values()];
  }
  async touchToken(tokenHash: string, now: Date) {
    const t = this.tokens.get(tokenHash);
    if (t) this.tokens.set(tokenHash, { ...t, lastUsedAt: now });
  }
}

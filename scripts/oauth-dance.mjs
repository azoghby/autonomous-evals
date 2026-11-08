// Scripted MCP OAuth dance against a running server using the official MCP SDK client.
// Usage: node scripts/oauth-dance.mjs [baseUrl]   (needs AUTH_DEV_LINKS on the server for the test session)
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.argv[2] ?? "http://localhost:3100";
const MCP = new URL("/api/mcp/mcp", BASE);
const REDIRECT = "http://127.0.0.1:53682/callback";
const ip = `192.0.2.${1 + Math.floor(Math.random() * 253)}`;
const step = (m) => console.log(`- ${m}`);
const must = (c, m) => { if (!c) { console.error(`FAIL: ${m}`); process.exit(1); } };

// Session for a test customer via the dev magic link (test helper; same as e2e/smoke.spec.ts).
async function session() {
  const email = `oauth-e2e+${Date.now()}@example.com`;
  const r = await fetch(new URL("/api/auth/request-link", BASE), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ email }) });
  const { devLink } = await r.json();
  must(devLink, `request-link returned no devLink (${r.status})`);
  const token = new URL(devLink).searchParams.get("token");
  const v = await fetch(new URL("/api/auth/verify", BASE), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = v.headers.get("set-cookie")?.split(";")[0];
  must(cookie?.startsWith("ae_session="), "no session cookie");
  return { cookie, email };
}

class Provider {
  constructor() { this.store = {}; }
  get redirectUrl() { return REDIRECT; }
  get clientMetadata() { return { client_name: "oauth-dance script", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }; }
  state() { return (this.store.state = `st-${Math.random().toString(36).slice(2)}`); }
  clientInformation() { return this.store.client; }
  saveClientInformation(c) { this.store.client = c; }
  tokens() { return this.store.tokens; }
  saveTokens(t) { this.store.tokens = t; }
  redirectToAuthorization(u) { this.store.authUrl = u; }
  saveCodeVerifier(v) { this.store.verifier = v; }
  codeVerifier() { return this.store.verifier; }
}

const p = new Provider();
const r1 = await auth(p, { serverUrl: MCP });
must(r1 === "REDIRECT" && p.store.authUrl, "SDK did not reach the authorize redirect");
step(`discovery + DCR ok: client_id=${p.store.client.client_id}`);
const au = p.store.authUrl;
must(au.searchParams.get("code_challenge_method") === "S256", "no S256");
must(au.searchParams.get("resource") === MCP.href, `resource=${au.searchParams.get("resource")}`);

const { cookie, email } = await session();
step(`test session for ${email}`);

// Unauthenticated authorize → sign-in redirect
const anon = await fetch(au, { redirect: "manual" });
step(`authorize without session → ${anon.status} ${anon.headers.get("location")?.slice(0, 40)}…`);

const page = await fetch(au, { headers: { cookie } });
const html = await page.text();
must(page.status === 200 && html.includes("oauth-dance script") && html.includes(email), `consent page ${page.status}`);
const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1]?.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
must(ticket, "no ticket");
step("consent screen shows client + email");

// CSRF: cross-site POST rejected, and POST without matching session rejected
const xs = await fetch(new URL("/oauth/authorize/decision", BASE), { method: "POST", redirect: "manual", headers: { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket, decision: "allow" }) });
must(xs.status === 403, `cross-site consent POST got ${xs.status}`);
const other = await session();
const xs2 = await fetch(new URL("/oauth/authorize/decision", BASE), { method: "POST", redirect: "manual", headers: { cookie: other.cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket, decision: "allow" }) });
must(xs2.status === 400, `ticket replayed with other session got ${xs2.status}`);
step("CSRF: cross-origin 403, foreign-session 400");

const dec = await fetch(new URL("/oauth/authorize/decision", BASE), { method: "POST", redirect: "manual", headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket, decision: "allow" }) });
const loc = new URL(dec.headers.get("location"));
must(dec.status === 303 && loc.href.startsWith(REDIRECT), `decision ${dec.status}`);
must(loc.searchParams.get("state") === p.store.state, "state mismatch");
const code = loc.searchParams.get("code");
step("consent → redirect with code + state");

const r2 = await auth(p, { serverUrl: MCP, authorizationCode: code });
must(r2 === "AUTHORIZED" && p.store.tokens?.access_token?.startsWith("aeo_at_"), "code exchange failed");
step(`token exchange ok (expires_in=${p.store.tokens.expires_in})`);

// Replay the code → invalid_grant
const replay = await fetch(new URL("/oauth/token", BASE), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: p.store.client.client_id, code, code_verifier: p.store.verifier, redirect_uri: REDIRECT }) });
must(replay.status === 400 && (await replay.json()).error === "invalid_grant", "code replay not rejected");
step("code replay → invalid_grant (and grant revoked)");

// Replay revoked the grant per RFC 6749 §4.1.2; re-run a fresh authorization to continue.
must((await fetch(MCP, { method: "POST", headers: { authorization: `Bearer ${p.store.tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) })).status === 401, "token survived code replay");
step("token from replayed code now 401");
p.store.tokens = undefined;
must(await auth(p, { serverUrl: MCP }) === "REDIRECT", "re-auth");
const html2 = await (await fetch(p.store.authUrl, { headers: { cookie } })).text();
const ticket2 = html2.match(/name="ticket" value="([^"]+)"/)[1].replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const dec2 = await fetch(new URL("/oauth/authorize/decision", BASE), { method: "POST", redirect: "manual", headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket: ticket2, decision: "allow" }) });
must(await auth(p, { serverUrl: MCP, authorizationCode: new URL(dec2.headers.get("location")).searchParams.get("code") }) === "AUTHORIZED", "second exchange");

const client = new Client({ name: "oauth-dance", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(MCP, { authProvider: p }));
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
must(names.includes("list_packages") && names.includes("sandbox_create_environment"), `tools: ${names}`);
step(`MCP tools/list via OAuth token: ${names.length} tools`);
const pk = await client.callTool({ name: "list_packages", arguments: {} });
must(!pk.isError, "list_packages errored");
step("list_packages ok");
await client.close();

// Refresh rotation
const old = p.store.tokens;
const ref = await fetch(new URL("/oauth/token", BASE), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: p.store.client.client_id, refresh_token: old.refresh_token }) });
const nt = await ref.json();
must(ref.status === 200 && nt.refresh_token !== old.refresh_token, "refresh failed");
step("refresh → rotated tokens");
const reuse = await fetch(new URL("/oauth/token", BASE), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: p.store.client.client_id, refresh_token: old.refresh_token }) });
must(reuse.status === 400, "old refresh accepted");
step("old refresh token reuse → invalid_grant, grant revoked");

// DCR rejects a non-loopback http redirect
const bad = await fetch(new URL("/oauth/register", BASE), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
must(bad.status === 400 && (await bad.json()).error === "invalid_redirect_uri", "bad redirect accepted");
step("DCR rejects http://evil.example redirect");
console.log("PASS: full MCP OAuth dance");

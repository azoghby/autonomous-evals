import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { MCP_PATH, MemoryOAuthStore, OAuthError, OAuthService, type OAuthStore } from "./core";
import { DbOAuthStore } from "./db-store";

/** Public origin of a request (Vercel sets x-forwarded-host/proto). Mirrors mcp-handler's getPublicOrigin. */
export function originFromHeaders(h: Headers, fallbackUrl?: string): string {
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (host) return `${h.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https"}://${host}`;
  if (fallbackUrl) return new URL(fallbackUrl).origin;
  const plainHost = h.get("host");
  return plainHost ? `${plainHost.startsWith("localhost") || plainHost.startsWith("127.") ? "http" : "https"}://${plainHost}` : "http://localhost:3000";
}

export const originOf = (req: Request): string => originFromHeaders(req.headers, req.url);

const UNDEFINED_TABLE = "42P01";
const isMissingTable = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string }; message?: string };
  return err?.code === UNDEFINED_TABLE || err?.cause?.code === UNDEFINED_TABLE || /relation "oauth_\w+" does not exist/.test(String(err?.message ?? ""));
};

type G = { __aeOAuthMemStore?: MemoryOAuthStore; __aeOAuthWarned?: boolean };
const g = globalThis as G;

async function emailOf(customerId: string): Promise<string> {
  const [c] = await db().select({ email: schema.customers.email }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
  return c?.email ?? "";
}

/**
 * Postgres store. Outside production only: if the oauth_* tables have not been migrated yet, fall back
 * to a process-local in-memory store (logged once) so the flow can be exercised locally before the
 * migration lands. Production never falls back: it errors.
 */
function makeStore(): OAuthStore {
  const real = new DbOAuthStore();
  if (process.env.NODE_ENV === "production" || process.env.OAUTH_STORE === "db") return real;
  const mem = () => (g.__aeOAuthMemStore ??= new MemoryOAuthStore(emailOf));
  if (process.env.OAUTH_STORE === "memory") return mem();
  return new Proxy(real, {
    get(target, prop: keyof OAuthStore) {
      const fn = target[prop];
      if (typeof fn !== "function") return fn;
      return async (...args: unknown[]) => {
        if (g.__aeOAuthMemStore) return (mem()[prop] as (...a: unknown[]) => unknown)(...args);
        try {
          return await (fn as (...a: unknown[]) => unknown).apply(target, args);
        } catch (e) {
          if (!isMissingTable(e)) throw e;
          if (!g.__aeOAuthWarned) {
            g.__aeOAuthWarned = true;
            console.warn("[oauth] oauth_* tables missing; using an in-memory OAuth store (dev only). Run the migration.");
          }
          return (mem()[prop] as (...a: unknown[]) => unknown)(...args);
        }
      };
    },
  });
}

let store: OAuthStore | undefined;
export function oauthStore(): OAuthStore { return (store ??= makeStore()); }

/** Issuer = public origin of this deployment; the MCP resource is `${origin}/api/mcp/mcp`. */
export function oauthService(origin: string): OAuthService {
  return new OAuthService({ store: oauthStore(), issuer: origin, resource: `${origin}${MCP_PATH}` });
}

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

export function oauthErrorResponse(e: unknown): Response {
  if (e instanceof OAuthError) {
    const headers: Record<string, string> = { ...NO_STORE };
    if (e.status === 401) headers["WWW-Authenticate"] = 'Basic realm="oauth"';
    return Response.json(e.toJSON(), { status: e.status, headers });
  }
  console.error("oauth endpoint failed", e instanceof Error ? e.message : "unknown error");
  return Response.json({ error: "server_error", error_description: "Internal error" }, { status: 500, headers: NO_STORE });
}

export const jsonNoStore = (body: unknown, status = 200): Response => Response.json(body, { status, headers: NO_STORE });

/** Parse `Authorization: Basic base64(id:secret)` (RFC 6749 §2.3.1: form-urlencoded components). */
export function parseBasicAuth(req: Request): { id: string; secret: string } | null {
  const h = req.headers.get("authorization");
  if (!h || !/^basic /i.test(h)) return null;
  try {
    const raw = Buffer.from(h.slice(6).trim(), "base64").toString("utf8");
    const i = raw.indexOf(":");
    if (i < 0) return null;
    return { id: decodeURIComponent(raw.slice(0, i)), secret: decodeURIComponent(raw.slice(i + 1)) };
  } catch { return null; }
}

/** Token/revoke bodies are application/x-www-form-urlencoded per RFC 6749; accept JSON too for lenient clients. */
export async function readForm(req: Request): Promise<URLSearchParams> {
  const ct = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (text.length > 20_000) throw new OAuthError("invalid_request", "Request body too large");
  if (ct.includes("application/json")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(obj).filter(([, v]) => typeof v === "string") as [string, string][]);
    } catch { throw new OAuthError("invalid_request", "Malformed JSON body"); }
  }
  return new URLSearchParams(text);
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
} as const;

export const withCors = (res: Response): Response => {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
};

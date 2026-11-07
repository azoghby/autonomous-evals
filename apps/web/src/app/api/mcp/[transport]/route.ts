import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { verifyApiKey } from "@/server/api-keys";
import { rateLimit } from "@/server/rate-limit";
import { TOOLS, type McpCaller } from "@/server/mcp-tools";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RATE_LIMIT = 60;
const RATE_WINDOW_SEC = 600;

const mcp = createMcpHandler((server) => {
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        title: t.title, description: t.description, inputSchema: t.inputSchema,
        annotations: { readOnlyHint: t.readOnly, openWorldHint: false },
      },
      (async (input: never, ctx: { http?: { authInfo?: { extra?: Record<string, unknown> }; req?: Request } }) => {
        const extra = ctx.http?.authInfo?.extra;
        if (!extra?.customerId) return { content: [{ type: "text" as const, text: '{"error":"Unauthorized"}' }], isError: true };
        const origin = (process.env.APP_URL ?? (ctx.http?.req ? new URL(ctx.http.req.url).origin : "")).replace(/\/$/, "");
        const caller: McpCaller = { customerId: String(extra.customerId), email: String(extra.email ?? ""), origin };
        try {
          return await t.run(caller, input);
        } catch (err) {
          console.error(`mcp tool ${t.name} failed`, err);
          return { content: [{ type: "text" as const, text: '{"error":"Internal error"}' }], isError: true };
        }
      }) as never,
    );
  }
}, { serverInfo: { name: "autonomous-evals", version: "1.0.0" } });

const authed = withMcpAuth(
  async (req) => {
    const keyId = req.auth?.clientId ?? "unknown";
    const rl = await rateLimit(`mcp:${keyId}`, RATE_LIMIT, RATE_WINDOW_SEC);
    if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
    return mcp(req);
  },
  async (_req, bearer) => {
    const key = await verifyApiKey(bearer);
    if (!key) return undefined;
    return { token: bearer!, clientId: key.keyId, scopes: [], extra: { customerId: key.customerId, email: key.email } };
  },
  { required: true },
);

/** Streamable HTTP only, served at /api/mcp/mcp. Other transports (sse, message) are not offered. */
async function handle(req: Request, ctx: { params: Promise<{ transport: string }> }) {
  const { transport } = await ctx.params;
  if (transport !== "mcp") return Response.json({ error: "Not found. Use /api/mcp/mcp (Streamable HTTP)." }, { status: 404 });
  return authed(req);
}

export { handle as GET, handle as POST, handle as DELETE };

import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { rateLimit } from "@/server/rate-limit";
import { z } from "zod";
import { TOOLS, HIRE_WORKFLOW_PROMPT, SAMPLE_REPORT_URI, sampleReportMarkdown, type McpCaller } from "@/server/mcp-tools";
import { SANDBOX_TOOLS } from "@/server/mcp-sandbox-tools";
import { authenticateMcpBearer } from "@/server/oauth/mcp-auth";
import { PRM_PATH } from "@/server/oauth/core";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RATE_LIMIT = 60;
const RATE_WINDOW_SEC = 600;

const mcp = createMcpHandler((server) => {
  for (const t of [...TOOLS, ...SANDBOX_TOOLS]) {
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

  const origin = () => (process.env.APP_URL ?? "").replace(/\/$/, "");
  server.registerResource(
    "sample-report",
    SAMPLE_REPORT_URI,
    { title: "Sample report", description: "A finished sample Trace Audit report (fictional agent): findings with evidence, verified fixes, pricing.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: sampleReportMarkdown(origin()) }] }),
  );
  server.registerPrompt(
    "sample_report",
    { title: "Show a sample report", description: "See what a delivered eval report looks like before hiring." },
    async () => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: `Here is a sample report from Autonomous Evals. Summarize what an agent would get for its money.\n\n${sampleReportMarkdown(origin())}` } }] }),
  );
  server.registerPrompt(
    "hire_eval",
    { title: "Hire an eval", description: "Step-by-step workflow for evaluating an agent: package, job, quote, payment, report, rerun.", argsSchema: { target: z.string().max(500).describe("What to evaluate, e.g. 'our support agent endpoint https://...'") } },
    async ({ target }) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text: HIRE_WORKFLOW_PROMPT(target) } }] }),
  );
}, { serverInfo: { name: "autonomous-evals", version: "1.0.0" } });

const authed = withMcpAuth(
  async (req) => {
    const keyId = req.auth?.clientId ?? "unknown";
    const rl = await rateLimit(`mcp:${keyId}`, RATE_LIMIT, RATE_WINDOW_SEC);
    if (!rl.ok) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
    return mcp(req);
  },
  // Accepts OAuth access tokens (aeo_at_, issued by /oauth/token) and dashboard API keys (ae_).
  (req, bearer) => authenticateMcpBearer(req, bearer),
  { required: true, resourceMetadataPath: PRM_PATH },
);

/** Streamable HTTP only, served at /api/mcp/mcp. Other transports (sse, message) are not offered. */
async function handle(req: Request, ctx: { params: Promise<{ transport: string }> }) {
  const { transport } = await ctx.params;
  if (transport !== "mcp") return Response.json({ error: "Not found. Use /api/mcp/mcp (Streamable HTTP)." }, { status: 404 });
  return authed(req);
}

export { handle as GET, handle as POST, handle as DELETE };

import { createInternalMcpHandler } from "@/server/naive-internal-mcp";
import { createInternalMcpDependencies } from "@/server/naive-internal-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;
async function handle(req: Request, ctx: { params: Promise<{ transport: string }> }) {
  const { transport } = await ctx.params;
  if (transport !== "mcp") return Response.json({ error: "not_found" }, { status: 404 });
  try {
    const deps = await createInternalMcpDependencies();
    if (!deps) return Response.json({ error: "unavailable" }, { status: 503 });
    return await createInternalMcpHandler(deps)(req);
  } catch { return Response.json({ error: "unavailable" }, { status: 503 }); }
}
export { handle as POST, handle as GET, handle as DELETE };

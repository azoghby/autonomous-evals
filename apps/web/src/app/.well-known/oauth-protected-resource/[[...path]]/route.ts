import { MCP_PATH, protectedResourceMetadata } from "@/server/oauth/core";
import { CORS_HEADERS, originOf } from "@/server/oauth/service";

export const dynamic = "force-dynamic";

/** RFC 9728 Protected Resource Metadata for the MCP endpoint, at the root and at the path-suffixed URL. */
export async function GET(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path } = await ctx.params;
  const suffix = path?.length ? `/${path.join("/")}` : "";
  if (suffix && suffix !== MCP_PATH) return Response.json({ error: "not_found" }, { status: 404, headers: CORS_HEADERS });
  const origin = originOf(req);
  return Response.json(protectedResourceMetadata(origin, `${origin}${MCP_PATH}`), {
    headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=3600" },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

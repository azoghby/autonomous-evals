import { authorizationServerMetadata } from "@/server/oauth/core";
import { CORS_HEADERS, originOf } from "@/server/oauth/service";

export const dynamic = "force-dynamic";

/** RFC 8414 Authorization Server Metadata. The issuer is the deployment origin (no path). */
export async function GET(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path } = await ctx.params;
  if (path?.length) return Response.json({ error: "not_found" }, { status: 404, headers: CORS_HEADERS });
  return Response.json(authorizationServerMetadata(originOf(req)), {
    headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=3600" },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

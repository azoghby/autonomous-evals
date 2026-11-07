import { isUuid, jsonError, requireViewer } from "@/server/http";
import { revokeApiKey } from "@/server/api-keys";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireViewer();
  if (auth.res) return auth.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Key not found");
  const ok = await revokeApiKey(auth.viewer.id, id);
  return ok ? Response.json({ ok: true }) : jsonError(404, "Key not found");
}

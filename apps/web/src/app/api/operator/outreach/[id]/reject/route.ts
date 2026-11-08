import { jsonError, requireOperator, isUuid } from "@/server/http";
import { rejectDraft } from "@/server/outreach-approve";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Draft not found");
  const r = await rejectDraft(id, auth.viewer.email);
  if (!r.ok) return jsonError(r.status, r.error);
  return Response.json({ ok: true, status: "rejected" });
}

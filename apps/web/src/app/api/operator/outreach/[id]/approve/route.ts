import { jsonError, requireOperator, isUuid } from "@/server/http";
import { approveAndSendDraft } from "@/server/outreach-approve";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Draft not found");
  // resendApproved: re-clicking Approve on an approved-but-unsent draft retries the send.
  const r = await approveAndSendDraft(id, auth.viewer.email, { resendApproved: true });
  if (!r.ok) return jsonError(r.status, r.error);
  return Response.json({ ok: true, status: r.status, ...(r.sendError ? { sendError: r.sendError } : {}) });
}

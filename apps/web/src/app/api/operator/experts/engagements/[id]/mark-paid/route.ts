import { isUuid, jsonError, requireOperator } from "@/server/http";
import { ExpertError, markEngagementPaid } from "@/server/experts";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Engagement not found");
  try {
    const e = await markEngagementPaid(id, auth.viewer.email);
    return Response.json({ ok: true, status: "paid", honorariumCents: e.honorariumCents });
  } catch (err) {
    if (err instanceof ExpertError) return jsonError(err.status, err.message);
    throw err;
  }
}

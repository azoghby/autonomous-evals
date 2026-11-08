import { isUuid, jsonError, requireOperator } from "@/server/http";
import { ExpertError } from "@/server/experts";
import { deleteSlot } from "@/server/expert-calls";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Slot not found");
  try {
    await deleteSlot(id);
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof ExpertError) return jsonError(err.status, err.message);
    throw err;
  }
}

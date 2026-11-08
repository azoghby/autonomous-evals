import { z } from "zod";
import { isUuid, jsonError, readJson, requireOperator } from "@/server/http";
import { setQuoteApproval } from "@/server/feedback";

const body = z.object({ approved: z.boolean() });

/** Operator-only: approve / unapprove a builder quote for the homepage "What builders say" section. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Response not found");
  const parsed = await readJson(req, body, 1024);
  if (!parsed.ok) return parsed.res;
  const ok = await setQuoteApproval(id, parsed.data.approved);
  if (!ok) return jsonError(404, "No consented, invite-linked quote with that id");
  return Response.json({ ok: true, approved: parsed.data.approved }, { headers: { "Cache-Control": "no-store" } });
}

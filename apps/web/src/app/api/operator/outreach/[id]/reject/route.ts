import { and, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { jsonError, requireOperator, isUuid } from "@/server/http";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Draft not found");
  const [draft] = await db().update(schema.outreachDrafts)
    .set({ status: "rejected", approvedBy: auth.viewer.email })
    .where(and(eq(schema.outreachDrafts.id, id), eq(schema.outreachDrafts.status, "pending"))).returning();
  if (!draft) return jsonError(409, "Draft is not pending");
  await db().insert(schema.interventions).values({
    operatorEmail: auth.viewer.email, kind: "other", note: `Rejected outreach ${id} to ${draft.toEmail}`,
  });
  return Response.json({ ok: true, status: "rejected" });
}

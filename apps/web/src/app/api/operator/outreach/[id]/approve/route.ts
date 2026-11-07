import { and, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { sendEmail } from "@ae/core/auth/email";
import { jsonError, requireOperator, isUuid } from "@/server/http";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Draft not found");

  // Atomic claim: only a pending draft can be approved, and only once.
  const [draft] = await db().update(schema.outreachDrafts)
    .set({ status: "approved", approvedBy: auth.viewer.email })
    .where(and(eq(schema.outreachDrafts.id, id), eq(schema.outreachDrafts.status, "pending"))).returning();
  if (!draft) {
    const [exists] = await db().select({ status: schema.outreachDrafts.status }).from(schema.outreachDrafts).where(eq(schema.outreachDrafts.id, id)).limit(1);
    return exists ? jsonError(409, `Draft is already ${exists.status}`) : jsonError(404, "Draft not found");
  }
  await db().insert(schema.interventions).values({
    operatorEmail: auth.viewer.email, kind: "approve_outreach", note: `Approved outreach ${id} to ${draft.toEmail}: ${draft.subject}`,
  });

  // Founder approval is recorded; send only when email is configured. Failure leaves the draft "approved" (retryable by operator).
  let sent = false, sendError: string | undefined;
  if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
    try {
      await sendEmail({ to: draft.toEmail, subject: draft.subject, text: draft.body });
      await db().update(schema.outreachDrafts).set({ status: "sent", sentAt: new Date() }).where(eq(schema.outreachDrafts.id, id));
      sent = true;
    } catch (err) {
      sendError = err instanceof Error ? err.message : "send failed";
      console.error("outreach send failed", err);
    }
  }
  return Response.json({ ok: true, status: sent ? "sent" : "approved", ...(sendError ? { sendError } : {}) });
}

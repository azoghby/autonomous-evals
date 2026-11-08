import { approveSqlManagedExpertDraft, expertOwnerDatabase } from './automated-expert-owner';
import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { sendEmail, isEmailConfigured } from "@ae/core/auth/email";
import { isAgentMailConfigured } from "@ae/core/email/agentmail";
import { guardOutreachSend } from "./experts";
import { recordEmailThread } from "./email-threads";
import { isOperator } from "@ae/core/auth/tokens";
import { isUuid } from "./http";
import { isSuppressed } from "./owner-shared";
import { containsLocalUrl } from "./public-url";
import { closeApprovalFromSource } from "./notify/sync";

export type ApproveResult =
  | { ok: true; status: "sent" | "approved"; sendError?: string }
  /** draftStatus is set when the draft was not pending (null when it does not exist). */
  | { ok: false; status: number; error: string; draftStatus?: string | null };

export interface ApproveOptions {
  syncApproval?: boolean;
  /**
   * Idempotent retry: an already-approved draft that was never sent is re-sent (suppression and localhost checks run
   * again), and an already-sent draft returns ok. Without it both return 409.
   */
  resendApproved?: boolean;
}

type SendableDraft = { toEmail: string; subject: string; body: string; kind: string | null };

/** Refuses drafts that must never go out, whatever their approval state. */
async function sendBlocker(d: SendableDraft): Promise<string | null> {
  // A draft generated without a public APP_URL carries http://localhost links (broken unsubscribe): never send it.
  if (containsLocalUrl(`${d.subject}\n${d.body}`)) {
    return "Draft contains a localhost link (broken unsubscribe/site URL). Reject it; the agent will redraft with production links.";
  }
  if (await isSuppressed(d.toEmail)) return "Recipient is on the suppression list; this draft must not be sent. Reject it.";
  return null;
}

/**
 * Operator approval of one pending outreach draft: guardrails, atomic pending->approved claim, intervention row,
 * then send (if email is configured). Shared by the single-approve route and the one-click approve-all route.
 */
async function approveLegacyDraft(id: string, approverEmail: string, opts: ApproveOptions = {}): Promise<ApproveResult> {
  const [pending] = await db().select({ toEmail: schema.outreachDrafts.toEmail, kind: schema.outreachDrafts.kind, subject: schema.outreachDrafts.subject, body: schema.outreachDrafts.body })
    .from(schema.outreachDrafts)
    .where(and(eq(schema.outreachDrafts.id, id), eq(schema.outreachDrafts.status, "pending"))).limit(1);
  if (pending) {
    // A draft generated without a public APP_URL carries http://localhost links (broken unsubscribe): never send it.
    if (containsLocalUrl(`${pending.subject}\n${pending.body}`)) {
      return { ok: false, status: 409, error: "Draft contains a localhost link (broken unsubscribe/site URL). Reject it; the agent will redraft with production links." };
    }
    if (pending.kind === "agent_invite" && (await isSuppressed(pending.toEmail))) {
      return { ok: false, status: 409, error: "Recipient is on the suppression list; this draft must not be sent. Reject it." };
    }
    // Expert Network guardrails: never send to a suppressed address; cap cold expert contacts per day.
    if (pending.kind !== "agent_invite") {
      const guard = await guardOutreachSend(id, pending.toEmail);
      if (!guard.ok) return { ok: false, status: guard.status, error: guard.error };
    }
  }

  // Atomic claim: only a pending draft can be approved, and only once.
  const [draft] = await db().update(schema.outreachDrafts)
    .set({ status: "approved", approvedBy: approverEmail })
    .where(and(eq(schema.outreachDrafts.id, id), eq(schema.outreachDrafts.status, "pending"))).returning();
  if (!draft) {
    const D = schema.outreachDrafts;
    const [exists] = await db().select({ status: D.status, toEmail: D.toEmail, subject: D.subject, body: D.body, kind: D.kind })
      .from(D).where(eq(D.id, id)).limit(1);
    if (!exists) return { ok: false, status: 404, error: "Draft not found", draftStatus: null };
    if (opts.resendApproved && exists.status === "sent") return { ok: true, status: "sent" };
    if (opts.resendApproved && exists.status === "approved") {
      const blocked = await sendBlocker(exists);
      if (blocked) return { ok: false, status: 409, error: blocked, draftStatus: exists.status };
      return sendApprovedDraft(id, exists);
    }
    return { ok: false, status: 409, error: `Draft is already ${exists.status}`, draftStatus: exists.status };
  }
  await db().insert(schema.interventions).values({
    operatorEmail: approverEmail, kind: "approve_outreach", note: `Approved outreach ${id} to ${draft.toEmail}: ${draft.subject}`,
  });
  // Decided in the console (not from the phone): close the matching founder approval so its buttons become no-ops.
  if (opts.syncApproval !== false) await closeApprovalFromSource("outreach_draft", id, "approved", approverEmail);

  return sendApprovedDraft(id, draft);
}

/** Sends an approved draft when email is configured. Failure leaves the draft "approved" (retryable via resendApproved). */
async function sendApprovedDraft(id: string, draft: SendableDraft): Promise<ApproveResult> {
  let sent = false, sendError: string | undefined;
  if (isAgentMailConfigured() || (isEmailConfigured() && process.env.EMAIL_FROM)) {
    try {
      const sentMail = await sendEmail({ purpose: "commercial", to: draft.toEmail, subject: draft.subject, text: draft.body });
      await db().update(schema.outreachDrafts).set({ status: "sent", sentAt: new Date() }).where(eq(schema.outreachDrafts.id, id));
      sent = true;
      try {
        const [engagement] = await db().select({ id: schema.expertEngagements.id }).from(schema.expertEngagements)
          .where(eq(schema.expertEngagements.outreachDraftId, id)).limit(1);
        if (engagement) await recordEmailThread(sentMail.threadId, "expert_outreach", { expertEngagementId: engagement.id });
      } catch (err) { console.error("record outreach thread failed", err); }
      if (String(draft.kind ?? "").startsWith("sdr_")) await markProspectContacted(id, sentMail.threadId);
    } catch (err) {
      sendError = err instanceof Error ? err.message : "send failed";
      console.error("outreach send failed", err);
    }
  }
  return { ok: true, status: sent ? "sent" : "approved", ...(sendError ? { sendError } : {}) };
}

export type RejectResult = { ok: true } | { ok: false; status: number; error: string };

/** Rejects one pending draft (atomic pending->rejected) and records an intervention. Shared by the console route and phone approvals. */
export async function rejectDraft(id: string, approverEmail: string, opts: { syncApproval?: boolean } = {}): Promise<RejectResult> {
  const [draft] = await db().update(schema.outreachDrafts)
    .set({ status: "rejected", approvedBy: approverEmail })
    .where(and(eq(schema.outreachDrafts.id, id), eq(schema.outreachDrafts.status, "pending"))).returning();
  if (!draft) return { ok: false, status: 409, error: "Draft is not pending" };
  await db().insert(schema.interventions).values({
    operatorEmail: approverEmail, kind: "other", note: `Rejected outreach ${id} to ${draft.toEmail}`,
  });
  if (opts.syncApproval !== false) await closeApprovalFromSource("outreach_draft", id, "rejected", approverEmail);
  return { ok: true };
}

/** After an SDR draft is sent: mark the prospect lead "contacted" and map the thread. Best-effort. */
async function markProspectContacted(draftId: string, threadId: string | null | undefined): Promise<void> {
  try {
    await db().update(schema.prospectLeads).set({ status: "contacted", updatedAt: new Date() })
      .where(eq(schema.prospectLeads.outreachDraftId, draftId));
    await recordEmailThread(threadId, "prospect", {});
  } catch (err) { console.error("mark prospect contacted failed", err); }
}

export type ApproveAllPayload = { ids?: unknown; op?: unknown; [k: string]: unknown };

/** Pure: the token's draft ids (valid UUIDs only, deduped) and operator, or null when the payload is unusable or the operator was revoked. */
export function parseApproveAll(payload: ApproveAllPayload | null): { ids: string[]; op: string } | null {
  if (!payload || typeof payload.op !== "string" || !Array.isArray(payload.ids)) return null;
  if (!isOperator(payload.op)) return null;
  const ids = [...new Set(payload.ids.filter((x): x is string => typeof x === "string" && isUuid(x)))];
  return { ids, op: payload.op };
}

/** Shared lock covers legacy and managed approvals so the existing daily cold cap has one writer gate. */
export async function approveAndSendDraft(id:string,approverEmail:string,opts:ApproveOptions={}):Promise<ApproveResult>{
 if(!isOperator(approverEmail))return {ok:false,status:403,error:'Operator access required'};
 const sql=expertOwnerDatabase();
 if(await approveSqlManagedExpertDraft(sql,id,approverEmail))return {ok:true,status:'approved'};
 return sql.transaction(async tx=>{
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('expert-cold-contact-approvals'))");
  return approveLegacyDraft(id,approverEmail,opts);
 });
}

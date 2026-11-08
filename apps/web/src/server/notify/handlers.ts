import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { approveAndSendDraft, rejectDraft } from "../outreach-approve";
import { registerApprovalHandler } from "./registry";

/**
 * Built-in founder-approval kinds. Add new kinds here (or import a module that calls registerApprovalHandler
 * from here) so every serverless entry point that decides approvals (webhooks, confirm page, console) has them.
 *
 * FYI-only kinds (plan_purchase, agent_audit_purchase, operator_alert) need no handler: requestFounderApproval({ fyi: true }).
 */

/** Outreach drafts (expert invites, agent invites): approve = the existing approve-and-send path (guardrails included). */
registerApprovalHandler("outreach_draft", {
  approveLabel: "Approve & send",
  rejectLabel: "Reject",
  viewPath: () => "/operator",
  async onDecision({ approval, decision, actor }) {
    if (decision === "reject") {
      const r = await rejectDraft(approval.ref, actor, { syncApproval: false });
      return r.ok ? { ok: true, note: `Rejected #${approval.seq}; nothing was sent.` } : { ok: false, note: r.error };
    }
    const r = await approveAndSendDraft(approval.ref, actor, { syncApproval: false });
    if (!r.ok) return { ok: false, note: r.error };
    if (r.sendError) return { ok: false, note: `Approved #${approval.seq} but the send failed (${r.sendError}); retry from /operator.` };
    return { ok: true, note: r.status === "sent" ? `Approved and sent #${approval.seq}.` : `Approved #${approval.seq} (email not configured, so not sent yet).` };
  },
});

/** Enterprise sales leads: FYI with a single "Mark contacted" action. */
registerApprovalHandler("sales_lead", {
  approveLabel: "Mark contacted",
  rejectLabel: null,
  viewPath: () => "/operator",
  async onDecision({ approval, decision }) {
    if (decision === "reject") return { ok: true, note: `Dismissed #${approval.seq}.` };
    const l = schema.salesLeads;
    const rows = await db().update(l).set({ status: "contacted" }).where(and(eq(l.id, approval.ref), eq(l.status, "new"))).returning({ id: l.id });
    return { ok: true, note: rows.length ? `Lead #${approval.seq} marked contacted.` : `Lead #${approval.seq} was already past "new"; nothing changed.` };
  },
});

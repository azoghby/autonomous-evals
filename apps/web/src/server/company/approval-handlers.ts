import "server-only";
/**
 * Founder-approval handlers for company agents (registered by kind; imported from notify/handlers.ts).
 * SDR drafts reuse the built-in "outreach_draft" kind (approve = approveAndSendDraft), so only the onboarding
 * over-budget gate is registered here.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { FOUNDER_OVERRIDE_KEY, appendTranscript } from "@ae/core/company/onboarding";
import { registerApprovalHandler } from "../notify/registry";

export const ONBOARDING_OVER_BUDGET_KIND = "onboarding_run_over_budget";

/** Pure: the conversation patch for a founder decision on an over-budget onboarding run. */
export function overBudgetDecisionPatch(
  conv: { collected: Record<string, unknown>; suiteId: string | null; transcript: Array<{ role: string; text: string; at: string }> },
  decision: "approve" | "reject",
  now: Date,
) {
  if (decision === "reject") {
    const text = "A founder reviewed this and can't cover a run over your plan's budget right now. Upgrading your plan at /pricing raises the limit; reply here if you have questions.";
    return { status: "blocked" as const, transcript: appendTranscript(conv.transcript, { role: "agent", text, at: now.toISOString() }) };
  }
  const text = conv.suiteId
    ? "A founder approved a minimal run (k=1, up to 3 scenarios). I'll start it shortly and send the results here."
    : "A founder approved a minimal run (k=1, up to 3 scenarios). Reply 'go' and I'll build your sandbox.";
  return {
    status: conv.suiteId ? ("building" as const) : ("collecting" as const),
    collected: { ...conv.collected, [FOUNDER_OVERRIDE_KEY]: true },
    transcript: appendTranscript(conv.transcript, { role: "agent", text, at: now.toISOString() }),
  };
}

registerApprovalHandler(ONBOARDING_OVER_BUDGET_KIND, {
  approveLabel: "Allow minimal run",
  rejectLabel: "Decline",
  viewPath: () => "/operator",
  async onDecision({ approval, decision }) {
    const conversationId = (approval.payload as { conversationId?: unknown } | null)?.conversationId;
    if (typeof conversationId !== "string") return { ok: false, note: "Approval has no conversation id." };
    const t = schema.onboardingConversations;
    const [conv] = await db().select().from(t).where(eq(t.id, conversationId)).limit(1);
    if (!conv) return { ok: false, note: "Conversation not found." };
    if (conv.status !== "blocked") return { ok: true, note: `Conversation is ${conv.status}; nothing to do.` };
    const patch = overBudgetDecisionPatch(conv, decision, new Date());
    await db().update(t).set({ ...patch, updatedAt: new Date() }).where(eq(t.id, conversationId));
    return { ok: true, note: decision === "approve" ? "Minimal run allowed; the onboarding agent will continue." : "Declined; the customer was told." };
  },
});

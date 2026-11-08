import "server-only";

/**
 * Thin, never-throwing entry points that existing gates call to put things on the founder's phone.
 * approvals.ts is imported lazily so domain modules (experts, outreach, sales leads, Stripe webhook)
 * do not create import cycles with the handler registry.
 */

const approvals = () => import("./approvals");

async function safe(label: string, fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (err) { console.error(`founder notify (${label}) failed`, err instanceof Error ? err.message : err); }
}

/** A new pending outreach draft. Prospect address is redacted to its domain; the subject is shown. */
export function notifyOutreachDraft(d: { id: string; kind: string; toEmail: string; subject: string }): Promise<void> {
  return safe("outreach_draft", async () => {
    const { requestFounderApproval } = await approvals();
    const label = d.kind === "agent_invite" ? "Agent invite"
      : d.kind === "sdr_first_touch" ? "SDR first touch"
      : d.kind === "sdr_follow_up" ? "SDR follow-up" : "Expert invite";
    await requestFounderApproval({
      kind: "outreach_draft", ref: d.id,
      title: `${label}: ${d.subject}`,
      summary: `${label} draft to ${d.toEmail}. Subject: "${d.subject}". Approving sends it now through the normal guarded path (suppression list, daily caps).`,
    });
  });
}

export function notifySalesLead(l: { id: string; company: string; name: string; volume: string; agentDescription: string }): Promise<void> {
  return safe("sales_lead", async () => {
    const { requestFounderApproval } = await approvals();
    await requestFounderApproval({
      kind: "sales_lead", ref: l.id, title: `Enterprise lead: ${l.company}`,
      summary: `${l.company}, volume ${l.volume}. ${l.agentDescription}`.slice(0, 600),
      expiresInMs: 30 * 24 * 60 * 60 * 1000,
    });
  });
}

export function notifyPlanPurchase(p: { sessionId: string; kind: "plan" | "agent_audit"; product: string; amountCents: number; environment: "live" | "test"; email: string }): Promise<void> {
  return safe("plan_purchase", async () => {
    const { requestFounderApproval } = await approvals();
    const amount = `$${(p.amountCents / 100).toFixed(2)}`;
    const env = p.environment === "live" ? "LIVE" : "test mode";
    await requestFounderApproval({
      kind: p.kind === "agent_audit" ? "agent_audit_purchase" : "plan_purchase", ref: p.sessionId, fyi: true, skipEmail: p.kind === "agent_audit",
      title: p.kind === "agent_audit" ? `Agent Audit purchased (${amount}, ${env})` : `Plan purchased: ${p.product} (${amount}, ${env})`,
      summary: `${p.kind === "agent_audit" ? "Agent Audit, deliver within 72h." : `Subscription ${p.product}.`} Buyer ${p.email}. ${env}.`,
    });
  });
}

/** Operator alerts (job failed, paused on budget, payment review, stale job...) as FYI with a link. */
export function notifyOperatorAlert(a: { kind: string; jobId?: string; title: string; detail: string; severity: string }, now = new Date()): Promise<void> {
  return safe("operator_alert", async () => {
    const { requestFounderApproval } = await approvals();
    await requestFounderApproval({
      kind: "operator_alert", fyi: true, skipEmail: true,
      // alertOperators already dedupes per (kind, jobId) per 6h; the timestamp keeps later re-alerts distinct.
      ref: `${a.kind}:${a.jobId ?? "-"}:${now.toISOString().slice(0, 13)}`,
      title: `${a.severity === "critical" ? "[!] " : ""}${a.title}${a.jobId ? ` (job ${a.jobId.slice(0, 8)})` : ""}`,
      summary: `${a.detail}${a.jobId ? " Open the job in /operator to resume, refund or cancel." : ""}`,
      payload: a.jobId ? { jobId: a.jobId } : {},
    });
  });
}

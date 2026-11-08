import { boundNote, FOUNDER_HELP, parseFounderReply, seqFromSubject } from "./founder-email-logic";

/** Result of one founder reply. Only "decided"/"approved_all" ever change state; notes are stored as data. */
export type FounderReplyResult = "decided" | "approved_all" | "note" | "no_target";

export interface FounderThreadRef {
  kind: "approval" | "report"; approvalSeq: number | null;
  /** Outreach drafts the email on this thread listed; YES ALL is scoped to exactly these. */
  draftIds?: string[] | null;
}

export interface FounderReplyInput {
  threadId: string;
  messageId: string;
  subject: string;
  text: string;
  thread: FounderThreadRef;
}

/** Side effects, injected so the decision flow is unit-testable without a database or mail transport. */
export interface FounderReplyDeps {
  decide(seq: number, decision: "approve" | "reject"): Promise<{ ok: boolean; message: string }>;
  /** Approves only these draft ids (those still pending); never drafts the founder has not been shown. */
  approveAllDrafts(ids: string[]): Promise<{ total: number; sent: number; approved: number; skipped: number }>;
  saveNote(n: { body: string; threadId: string; messageId: string; approvalSeq: number | null }): Promise<void>;
  reply(text: string): Promise<void>;
}

/**
 * Handles an already-authenticated founder reply (sender matched FOUNDER_EMAIL, auth verdicts ok, thread is one we started).
 * Commands go through decideApproval (idempotent, audited); everything else is stored as a note and never acted on.
 */
export async function processFounderReply(input: FounderReplyInput, deps: FounderReplyDeps): Promise<FounderReplyResult> {
  const cmd = parseFounderReply(input.text);
  const threadSeq = input.thread.approvalSeq ?? (input.thread.kind === "approval" ? seqFromSubject(input.subject) : null);

  if (cmd.kind === "approve_all") {
    const listed = input.thread.draftIds ?? [];
    if (listed.length === 0) {
      await deps.reply("That email did not list any outreach drafts, so nothing was approved. Reply YES ALL to a daily report, or use its review link.");
      return "no_target";
    }
    const r = await deps.approveAllDrafts(listed);
    await deps.reply(r.total === 0 ? "No pending outreach drafts." : `Approved ${r.total} draft(s): ${r.sent} sent, ${r.approved} approved (not sent), ${r.skipped} skipped.`);
    return "approved_all";
  }

  if (cmd.kind === "decide") {
    const seq = cmd.seq ?? threadSeq;
    if (seq === null) {
      await deps.reply("Which one? Reply YES 12 or NO 12 (the number is in the subject), or reply to that approval's own email.");
      return "no_target";
    }
    const r = await deps.decide(seq, cmd.decision);
    await deps.reply(r.message);
    return "decided";
  }

  const body = boundNote(input.text);
  if (body) await deps.saveNote({ body, threadId: input.threadId, messageId: input.messageId, approvalSeq: threadSeq });
  await deps.reply(FOUNDER_HELP);
  return "note";
}

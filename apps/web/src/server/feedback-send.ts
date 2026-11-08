/**
 * Send loop for the one-off feedback campaign (driven by scripts/feedback-outreach.ts). All IO is injected so the
 * double-send guarantees are unit-tested without a database or a mail provider.
 *
 * At-most-once per recipient:
 *  - A row is atomically claimed (pending -> sending) before the provider call; only the claimer sends.
 *  - Success marks it sent with the message id. An error marks it failed. 'sending' and 'failed' rows are never
 *    retried automatically: a crash or DB error after the provider accepted a message must not email the person twice.
 *  - The campaign cap counts sending + sent + failed (+ replied / any sentAt), so unknown outcomes use up budget.
 */
import {
  FEEDBACK_EMAIL_MAX_WORDS, FEEDBACK_SEND_CAP, FOUNDER_REPLY_TO, buildFeedbackEmail, feedbackBodyWords, type FeedbackRecipient,
} from "./feedback-logic";

export interface OutreachInvite { id: string; token: string; status: string; sentAt: Date | null }

export interface OutreachStore {
  findByEmail(email: string): Promise<OutreachInvite | null>;
  /** Rows that used (or may have used) a send: status in sending|sent|failed|replied, or sentAt set. */
  usedCount(): Promise<number>;
  /** Insert a pending row; on an email/token conflict return the existing row instead. */
  insertPending(r: FeedbackRecipient, token: string): Promise<OutreachInvite>;
  /** `update ... set status='sending' where id=$1 and status='pending' returning id`. True only for the claimer. */
  claim(id: string): Promise<boolean>;
  markSent(id: string, sent: { messageId: string; threadId: string | null; sentAt: Date }): Promise<void>;
  /** Only moves a row we claimed ('sending'); never touches a row another run finished. */
  markFailed(id: string): Promise<void>;
  /** Provider never sent (suppressed / dry-run transport): release a claimed row to the given status. */
  release(id: string, status: "pending" | "suppressed"): Promise<void>;
  /** Mark a still-pending row suppressed. */
  markSuppressed(id: string): Promise<void>;
}

export type OutreachSendResult =
  | { status: "sent"; sent: { id: string; threadId?: string | null } }
  | { status: "dry_run" }
  | { status: "suppressed" };

export interface OutreachMessage {
  to: string; subject: string; text: string; headers: Record<string, string>; replyTo: string; labels: string[];
}

export interface SentRecord {
  sentAt: string; recipient: string; name: string | null; org: string; sourceUrl: string;
  messageId: string; threadId: string | null; inviteId: string;
}

export interface OutreachDeps {
  store: OutreachStore;
  isSuppressed(email: string): Promise<boolean>;
  sendEmail(msg: OutreachMessage): Promise<OutreachSendResult>;
  newToken(): string;
  appUrl: string;
  companyAddress: string | null;
  log(line: string): void;
  writePreview(file: string, text: string): void;
  recordSent(rec: SentRecord): void;
  recordError(line: string): void;
  sleep(ms: number): Promise<void>;
  now?: () => Date;
  spacingMs?: number;
  cap?: number;
}

export interface OutreachSummary { rendered: number; sent: number; failed: number; skipped: number; capReached: boolean }

const LOCAL_LINK = /localhost|127\.0\.0\.1/i;
const pad = (n: number) => String(n + 1).padStart(2, "0");
export const maskEmail = (e: string): string => e.replace(/^(.).*(@.*)$/, "$1***$2");
export const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Renders every recipient; with send=true, claims and sends each eligible one at most once. */
export async function runFeedbackOutreach(
  recipients: readonly FeedbackRecipient[], opts: { send: boolean }, deps: OutreachDeps,
): Promise<OutreachSummary> {
  const cap = deps.cap ?? FEEDBACK_SEND_CAP;
  const now = deps.now ?? (() => new Date());
  const summary: OutreachSummary = { rendered: 0, sent: 0, failed: 0, skipped: 0, capReached: false };
  if (recipients.length > cap) throw new Error(`${recipients.length} recipients exceeds the cap of ${cap}`);
  if (new Set(recipients.map((r) => r.email.toLowerCase())).size !== recipients.length) throw new Error("duplicate recipient email");

  for (const [n, r] of recipients.entries()) {
    const tag = `${pad(n)} ${r.org}`;
    const existing = await deps.store.findByEmail(r.email);
    if (existing && (existing.sentAt || existing.status !== "pending")) {
      deps.log(`${tag}: skip, invite is '${existing.status}'${existing.sentAt ? ` (sent ${existing.sentAt.toISOString()})` : ""}; never auto-retried`);
      summary.skipped++;
      continue;
    }
    if (await deps.isSuppressed(r.email)) {
      deps.log(`${tag}: skip, suppressed`);
      if (opts.send && existing) await deps.store.markSuppressed(existing.id);
      summary.skipped++;
      continue;
    }

    const token = existing?.token ?? (opts.send ? deps.newToken() : `dryrun-${slugify(r.org)}`);
    const email = buildFeedbackEmail(r, { appUrl: deps.appUrl, token, companyAddress: deps.companyAddress });
    if (LOCAL_LINK.test(`${email.subject}\n${email.text}\n${Object.values(email.headers).join("\n")}`)) {
      throw new Error(`${tag}: refusing, body contains a localhost link`);
    }
    const words = feedbackBodyWords(email.text);
    if (words > FEEDBACK_EMAIL_MAX_WORDS) throw new Error(`${tag}: body is ${words} words (max ${FEEDBACK_EMAIL_MAX_WORDS})`);
    deps.writePreview(`${pad(n)}-${slugify(r.org)}.txt`,
      `To: ${r.email}\nReply-To: ${FOUNDER_REPLY_TO}\nSubject: ${email.subject}\nSource: ${r.sourceUrl}\nWords: ${words}\n\n${email.text}\n`);
    summary.rendered++;
    if (!opts.send) { deps.log(`${tag}: ${maskEmail(r.email)} rendered (${words} words)`); continue; }

    if ((await deps.store.usedCount()) >= cap) {
      deps.log(`${tag}: stop, cap of ${cap} reached`);
      summary.capReached = true;
      break;
    }
    const invite = existing ?? (await deps.store.insertPending(r, token));
    // A token mismatch means another run inserted this row first; leave it to that run.
    if (invite.token !== token || invite.sentAt || invite.status !== "pending" || !(await deps.store.claim(invite.id))) {
      deps.log(`${tag}: skip, claimed or finished by another run`);
      summary.skipped++;
      continue;
    }

    let accepted: string | null = null;
    try {
      const res = await deps.sendEmail({
        to: r.email, subject: email.subject, text: email.text, headers: email.headers, replyTo: FOUNDER_REPLY_TO, labels: ["feedback_invite"],
      });
      if (res.status !== "sent") {
        await deps.store.release(invite.id, res.status === "suppressed" ? "suppressed" : "pending");
        deps.log(`${tag}: not sent (${res.status})`);
        summary.skipped++;
        continue;
      }
      accepted = res.sent.id;
      const sentAt = now();
      const threadId = res.sent.threadId ?? null;
      // Local record first: if the DB write below fails we still know this person was emailed.
      deps.recordSent({ sentAt: sentAt.toISOString(), recipient: r.email, name: r.name, org: r.org, sourceUrl: r.sourceUrl, messageId: res.sent.id, threadId, inviteId: invite.id });
      await deps.store.markSent(invite.id, { messageId: res.sent.id, threadId, sentAt });
      summary.sent++;
      deps.log(`${tag}: sent ${maskEmail(r.email)} message ${res.sent.id}`);
    } catch (err) {
      summary.failed++;
      const note = accepted ? ` (provider ACCEPTED message ${accepted}; do not resend)` : "";
      deps.recordError(`${now().toISOString()} ${r.org} invite ${invite.id}: ${errText(err)}${note}`);
      try { await deps.store.markFailed(invite.id); } catch (e) {
        deps.recordError(`${now().toISOString()} ${r.org} invite ${invite.id}: markFailed also failed (${errText(e)}); row stays 'sending'`);
      }
      deps.log(`${tag}: FAILED, marked failed, will not be retried (see errors.log)`);
    }
    await deps.sleep(deps.spacingMs ?? 5_000);
  }
  return summary;
}

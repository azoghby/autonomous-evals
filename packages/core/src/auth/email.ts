import { Resend } from "resend";
import { inboxIdFor, isAgentMailConfigured, sendFromInbox, type EmailAttachment, type EmailPurpose } from "../email/agentmail";

export interface EmailMessage {
  to: string; subject: string; text: string; html?: string;
  /** Which AgentMail inbox sends this. Default "commercial". */
  purpose?: EmailPurpose;
  labels?: string[];
  /** Optional attachments (content base64), e.g. a calendar .ics. */
  attachments?: EmailAttachment[];
}
export interface SentEmail { id: string | null; threadId?: string | null }

/** True when some transport can deliver real mail (AgentMail, or the Resend fallback). */
export const isEmailConfigured = () =>
  isAgentMailConfigured() || !!process.env.RESEND_API_KEY;

/**
 * Sends via AgentMail (inbox chosen by purpose). Resend is only a fallback when AGENTMAIL_API_KEY is absent.
 * Throws if the transport is unconfigured or the API errors.
 */
export async function sendEmail(msg: EmailMessage): Promise<SentEmail> {
  if (isAgentMailConfigured()) {
    const sent = await sendFromInbox(inboxIdFor(msg.purpose ?? "commercial"), {
      to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, labels: msg.labels, attachments: msg.attachments,
    });
    return { id: sent.messageId, threadId: sent.threadId };
  }
  return sendViaResend(msg);
}

async function sendViaResend(msg: EmailMessage): Promise<SentEmail> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key) throw new Error("No email transport: set AGENTMAIL_API_KEY (or RESEND_API_KEY as fallback)");
  if (!from) throw new Error("EMAIL_FROM is not set");
  const { data, error } = await new Resend(key).emails.send({
    from, to: msg.to, subject: msg.subject, text: msg.text, ...(msg.html ? { html: msg.html } : {}),
    ...(msg.attachments?.length ? { attachments: msg.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, "base64") })) } : {}),
  });
  if (error) throw new Error(`Email send failed: ${error.message}`);
  return { id: data?.id ?? null };
}

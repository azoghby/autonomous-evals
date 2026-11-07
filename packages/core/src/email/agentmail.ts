import { AgentMailClient } from "agentmail";

export type EmailPurpose = "auth" | "commercial";

export interface SendFromInboxInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  labels?: string[];
  /** `content` is base64. */
  attachments?: EmailAttachment[];
}
export interface EmailAttachment { filename: string; contentType: string; content: string }
export interface SentMessage { messageId: string; threadId: string }

export const isAgentMailConfigured = () => !!process.env.AGENTMAIL_API_KEY;

let cached: { key: string; client: AgentMailClient } | undefined;

export function agentMailClient(): AgentMailClient {
  const key = process.env.AGENTMAIL_API_KEY;
  if (!key) throw new Error("AGENTMAIL_API_KEY is not set");
  if (cached?.key !== key) cached = { key, client: new AgentMailClient({ apiKey: key }) };
  return cached.client;
}

/** Inbox id (= its address) for a purpose. Falls back to the commercial inbox for auth if no auth inbox is set. */
export function inboxIdFor(purpose: EmailPurpose): string {
  const id = purpose === "auth"
    ? (process.env.AGENTMAIL_AUTH_INBOX_ID || process.env.AGENTMAIL_COMMERCIAL_INBOX_ID)
    : process.env.AGENTMAIL_COMMERCIAL_INBOX_ID;
  if (!id) throw new Error(`AGENTMAIL_${purpose === "auth" ? "AUTH" : "COMMERCIAL"}_INBOX_ID is not set`);
  return id;
}

export async function sendFromInbox(inboxId: string, input: SendFromInboxInput): Promise<SentMessage> {
  const res = await agentMailClient().inboxes.messages.send(inboxId, {
    to: input.to, subject: input.subject, text: input.text,
    ...(input.html ? { html: input.html } : {}),
    ...(input.labels?.length ? { labels: input.labels } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  });
  return { messageId: res.messageId, threadId: res.threadId };
}

/** Replies within an existing thread (to the given inbound message id). */
export async function replyInThread(
  inboxId: string, messageId: string, input: { text: string; html?: string; labels?: string[] },
): Promise<SentMessage> {
  const res = await agentMailClient().inboxes.messages.reply(inboxId, messageId, {
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
    ...(input.labels?.length ? { labels: input.labels } : {}),
  });
  return { messageId: res.messageId, threadId: res.threadId };
}

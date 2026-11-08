import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;

/**
 * Verifies a Svix-style webhook signature (AgentMail signs webhooks with Svix).
 * signed content = `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 with the base64 key after "whsec_",
 * header `svix-signature` = space-separated `v1,<base64>` entries. Constant-time compare, 5 min replay window.
 */
export function verifyWebhookSignature(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest();
  for (const part of headers.signature.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

export interface InboundMessage {
  eventType: string;
  inboxId: string;
  threadId: string;
  messageId: string;
  from: string;
  subject: string;
  text: string;
}

const pick = (o: Record<string, unknown>, camel: string, snake: string) => o[camel] ?? o[snake];
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Normalizes a webhook payload (camelCase or snake_case) into the fields we use. Null if not a usable message event. */
export function parseInboundEvent(payload: unknown): InboundMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const msg = p.message;
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const messageId = str(pick(m, "messageId", "message_id"));
  const threadId = str(pick(m, "threadId", "thread_id"));
  const inboxId = str(pick(m, "inboxId", "inbox_id"));
  if (!messageId || !threadId || !inboxId) return null;
  const from = pick(m, "from", "from_");
  return {
    eventType: str(pick(p, "eventType", "event_type")),
    inboxId, threadId, messageId,
    from: Array.isArray(from) ? str(from[0]) : str(from),
    subject: str(m.subject),
    text: str(pick(m, "extractedText", "extracted_text")) || str(m.text) || str(m.preview),
  };
}

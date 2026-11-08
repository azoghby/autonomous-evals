/** WhatsApp via Twilio (plain-text replies). Pure + fetch-injectable: no server-only, no DB. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { truncate, type ApprovalMessage, type Env, type FetchLike } from "./types";

const TWILIO_API = "https://api.twilio.com/2010-04-01/Accounts";

export function twilioConfigured(env: Env = process.env): boolean {
  return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM);
}

/** "+1 (415) 555-1234" | "whatsapp:+14155551234" -> "whatsapp:+14155551234" (E.164, 8-15 digits) or null. */
export function normalizeWhatsAppNumber(input: string): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (/^whatsapp:/i.test(s)) s = s.slice("whatsapp:".length).trim();
  if (!/^\+?[\d\s\-().]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) return null;
  return `whatsapp:+${digits}`;
}

export function formatWhatsAppApproval(msg: ApprovalMessage): string {
  let instructions = "(FYI)";
  if (msg.actions) {
    const rej = msg.actions.rejectLabel ? ` or NO ${msg.seq} (${msg.actions.rejectLabel})` : "";
    instructions = `Reply YES ${msg.seq} (${msg.actions.approveLabel})${rej}`;
  }
  return truncate(`#${msg.seq} ${msg.title}\n\n${msg.summary}\n\n${instructions}\nView: ${msg.viewUrl}`);
}

export async function sendWhatsApp(
  to: string,
  body: string,
  opts: { env?: Env; fetchImpl?: FetchLike } = {},
): Promise<{ sid: string }> {
  const env = opts.env ?? process.env;
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const fromRaw = env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !fromRaw) throw new Error("twilio not configured");
  const toNorm = normalizeWhatsAppNumber(to);
  if (!toNorm) throw new Error("invalid WhatsApp recipient number");
  const from = normalizeWhatsAppNumber(fromRaw);
  if (!from) throw new Error("invalid TWILIO_WHATSAPP_FROM");

  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init) as ReturnType<FetchLike>);
  const res = await doFetch(`${TWILIO_API}/${encodeURIComponent(sid)}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ From: from, To: toNorm, Body: body }).toString(),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { code?: unknown; message?: unknown };
      detail = [j.code, j.message].filter((x) => x !== undefined && x !== null).join(" ");
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`twilio send failed: ${res.status} ${detail}`.trim().split(token).join("[redacted]"));
  }
  const data = (await res.json()) as { sid?: unknown };
  if (typeof data.sid !== "string") throw new Error("twilio send failed: missing message sid");
  return { sid: data.sid };
}

/** Twilio request signature: base64(HMAC-SHA1(token, url + sorted key+value pairs)). */
export function computeTwilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null,
  authToken: string | undefined,
): boolean {
  if (!signature || !authToken) return false;
  const expected = Buffer.from(computeTwilioSignature(url, params, authToken));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const APPROVE_WORDS = new Set(["YES", "Y", "APPROVE", "OK"]);
const REJECT_WORDS = new Set(["NO", "N", "REJECT"]);

/** "YES 12", "yes12", "Yes #12", "no 3" -> decision + seq; anything else null. */
export function parseWhatsAppReply(body: string): { decision: "approve" | "reject"; seq: number } | null {
  const m = /^([a-z]+)\s*#?\s*(\d{1,9})$/i.exec((body ?? "").trim());
  if (!m) return null;
  const word = m[1].toUpperCase();
  const seq = Number(m[2]);
  if (APPROVE_WORDS.has(word)) return { decision: "approve", seq };
  if (REJECT_WORDS.has(word)) return { decision: "reject", seq };
  return null;
}

export function formParamsToRecord(form: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  form.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export const TWILIO_EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function twimlMessage(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(text)}</Message></Response>`;
}

import { rateLimit } from "@/server/rate-limit";
import { appUrl } from "@/server/owner-shared";
import { decideApproval } from "@/server/notify/approvals";
import { getFounderSettings, resolveWhatsAppTo } from "@/server/notify/channels";
import {
  formParamsToRecord, normalizeWhatsAppNumber, parseWhatsAppReply, TWILIO_EMPTY_TWIML, twilioConfigured, twimlMessage, validateTwilioSignature,
} from "@/server/notify/whatsapp";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;
const twiml = (xml: string, status = 200) => new Response(xml, { status, headers: { "Content-Type": "text/xml; charset=utf-8" } });

/** The exact URL configured in Twilio (signatures are computed over it). Override when the public URL differs. */
const webhookUrl = () => process.env.TWILIO_WEBHOOK_URL || `${appUrl()}/api/notify/whatsapp`;

/**
 * Twilio inbound WhatsApp webhook. Validates X-Twilio-Signature, then accepts "YES 12" / "NO 12" only from
 * the bound founder number. Replies with TwiML.
 */
export async function POST(request: Request) {
  if (!twilioConfigured()) return twiml(TWILIO_EMPTY_TWIML, 404);
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return twiml(TWILIO_EMPTY_TWIML, 413);
  const params = formParamsToRecord(new URLSearchParams(raw));
  if (!validateTwilioSignature(webhookUrl(), params, request.headers.get("x-twilio-signature"), process.env.TWILIO_AUTH_TOKEN)) {
    return twiml(TWILIO_EMPTY_TWIML, 403);
  }
  const rl = await rateLimit("notify-whatsapp", 60, 60);
  if (!rl.ok) return twiml(TWILIO_EMPTY_TWIML, 429);

  try {
    const founder = resolveWhatsAppTo(await getFounderSettings());
    const from = params.From ? normalizeWhatsAppNumber(params.From) : null;
    // Only the bound founder number may decide; everyone else gets silence (no oracle).
    if (!founder || !from || from !== founder) return twiml(TWILIO_EMPTY_TWIML);

    const reply = parseWhatsAppReply(params.Body ?? "");
    if (!reply) return twiml(twimlMessage("Reply YES <n> to approve or NO <n> to reject (n is the # in the message)."));
    const r = await decideApproval({ seq: reply.seq, decision: reply.decision, via: "whatsapp" });
    return twiml(twimlMessage(r.message));
  } catch (err) {
    console.error("whatsapp webhook failed", err instanceof Error ? err.message : err);
    return twiml(twimlMessage("Something went wrong. Check the operator console before retrying."));
  }
}

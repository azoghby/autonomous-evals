import { verifyWebhookSignature, parseInboundEvent } from "@ae/core/email/webhook";
import { drizzleInboundStore, handleInbound } from "@/server/inbound-email";

// Raw body is needed for signature verification, so read text() before parsing.
export async function POST(req: Request) {
  const raw = await req.text();
  const ok = verifyWebhookSignature(raw, {
    id: req.headers.get("svix-id"),
    timestamp: req.headers.get("svix-timestamp"),
    signature: req.headers.get("svix-signature"),
  }, process.env.AGENTMAIL_WEBHOOK_SECRET);
  if (!ok) return Response.json({ error: "Invalid signature" }, { status: 401 });

  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const msg = parseInboundEvent(payload);
  if (!msg) return Response.json({ ok: true, ignored: true });

  // Quick DB writes, done inline: a non-2xx makes AgentMail retry, and a failure releases the idempotency claim.
  try {
    const result = await handleInbound(msg, drizzleInboundStore());
    return Response.json({ ok: true, result });
  } catch (err) {
    console.error("agentmail inbound failed", msg.messageId, err instanceof Error ? err.message : err);
    return Response.json({ error: "Processing failed" }, { status: 500 });
  }
}

import { rateLimit } from "@/server/rate-limit";
import { decideApproval } from "@/server/notify/approvals";
import { bindTelegramChat, getFounderSettings, resolveTelegramChat } from "@/server/notify/channels";
import { answerTelegramCallback, parseTelegramUpdate, sendTelegramText, telegramConfigured, verifyTelegramSecret } from "@/server/notify/telegram";
import { parseWhatsAppReply } from "@/server/notify/whatsapp";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const HELP = "Standard Evals founder bot. Tap the buttons on approval messages, or reply YES <n> / NO <n>.";

/**
 * Telegram webhook (setWebhook with secret_token = TELEGRAM_WEBHOOK_SECRET). Verifies the secret header first,
 * then only acts for the bound founder chat. Always 200s after verification so Telegram does not retry-storm.
 */
export async function POST(request: Request) {
  if (!telegramConfigured()) return Response.json({ error: "not configured" }, { status: 404 });
  if (!verifyTelegramSecret(request.headers.get("x-telegram-bot-api-secret-token"))) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rl = await rateLimit("notify-telegram", 120, 60);
  if (!rl.ok) return Response.json({ ok: false }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return Response.json({ ok: true });
  let update: unknown;
  try { update = JSON.parse(raw); } catch { return Response.json({ ok: true }); }

  try {
    const inbound = parseTelegramUpdate(update);
    if (inbound.type === "ignored") return Response.json({ ok: true });
    const bound = resolveTelegramChat(await getFounderSettings());

    if (inbound.type === "start") {
      const perChat = await rateLimit(`notify-telegram-start:${inbound.chatId}`, 5, 600);
      if (!perChat.ok) return Response.json({ ok: true });
      if (bound === inbound.chatId) { await sendTelegramText(inbound.chatId, `Already linked. ${HELP}`); return Response.json({ ok: true }); }
      const linked = await bindTelegramChat(inbound.code, inbound.chatId);
      await sendTelegramText(inbound.chatId, linked
        ? "Linked. You will get approval requests and the daily report here."
        : "That link code is invalid or expired. Generate a new one in /operator > Notifications and send /start <code>.");
      return Response.json({ ok: true });
    }

    // Everything below is a decision: only the bound founder chat may make one.
    if (!bound || inbound.chatId !== bound) {
      if (inbound.type === "decision") await answerTelegramCallback(inbound.callbackQueryId, "Not authorized.");
      return Response.json({ ok: true });
    }

    if (inbound.type === "decision") {
      const r = await decideApproval({ seq: inbound.seq, decision: inbound.decision, via: "telegram" });
      await answerTelegramCallback(inbound.callbackQueryId, r.message);
      if (!r.changed) await sendTelegramText(inbound.chatId, r.message);
      return Response.json({ ok: true });
    }

    const reply = parseWhatsAppReply(inbound.text);
    if (!reply) { await sendTelegramText(inbound.chatId, HELP); return Response.json({ ok: true }); }
    const r = await decideApproval({ seq: reply.seq, decision: reply.decision, via: "telegram" });
    if (!r.changed) await sendTelegramText(inbound.chatId, r.message);
    return Response.json({ ok: true });
  } catch (err) {
    console.error("telegram webhook failed", err instanceof Error ? err.message : err);
    return Response.json({ ok: true });
  }
}

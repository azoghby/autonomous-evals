import { z } from "zod";
import { isEmailConfigured } from "@ae/core/auth/email";
import { founderRecipients } from "@/server/notify/founder-email-logic";
import { jsonError, readJson, requireOperator } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { maskPhone } from "@/server/notify/approvals-logic";
import { listFounderNotes } from "@/server/notify/founder-email";
import { decideApproval, listApprovals } from "@/server/notify/approvals";
import {
  createTelegramLinkCode, getFounderSettings, resolveTelegramChat, resolveWhatsAppTo, sendFounderText, updateFounderSettings,
} from "@/server/notify/channels";
import { telegramApi, telegramConfigured } from "@/server/notify/telegram";
import { normalizeWhatsAppNumber, twilioConfigured } from "@/server/notify/whatsapp";

export const dynamic = "force-dynamic";

let cachedBotUsername: string | null | undefined;
async function botUsername(): Promise<string | null> {
  if (process.env.TELEGRAM_BOT_USERNAME) return process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, "");
  if (cachedBotUsername !== undefined) return cachedBotUsername;
  if (!telegramConfigured()) return null;
  try { cachedBotUsername = (await telegramApi<{ username?: string }>("getMe", {})).username ?? null; }
  catch { cachedBotUsername = null; }
  return cachedBotUsername;
}

export async function GET() {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const s = await getFounderSettings();
  const hasCode = !!s.telegramLinkCodeExpiresAt && s.telegramLinkCodeExpiresAt.getTime() > Date.now();
  return Response.json({
    channels: {
      telegram: {
        configured: telegramConfigured(), bound: !!resolveTelegramChat(s), botUsername: await botUsername(),
        // The plaintext code is only returned once, at creation; here we only say one is outstanding.
        linkCode: null, linkCodeExpiresAt: hasCode ? s.telegramLinkCodeExpiresAt!.toISOString() : null,
      },
      whatsapp: { configured: twilioConfigured(), to: maskPhone(resolveWhatsAppTo(s)) },
      email: { configured: isEmailConfigured(), recipients: founderRecipients().length },
    },
    approvals: await listApprovals(100),
    notes: await listFounderNotes(50),
  }, { headers: { "Cache-Control": "no-store" } });
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("telegram_link") }),
  z.object({ action: z.literal("telegram_unlink") }),
  z.object({ action: z.literal("set_whatsapp"), to: z.string().max(40).nullable() }),
  z.object({ action: z.literal("test") }),
  z.object({ action: z.literal("decide"), id: z.uuid(), decision: z.enum(["approve", "reject"]) }),
]);

export async function POST(req: Request) {
  const auth = await requireOperator();
  if (auth.res) return auth.res;
  const body = await readJson(req, Body);
  if (!body.ok) return body.res;
  const b = body.data;
  switch (b.action) {
    case "telegram_link": {
      if (!telegramConfigured()) return jsonError(400, "Telegram is not configured (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET).");
      const { code, expiresAt } = await createTelegramLinkCode();
      const user = await botUsername();
      return Response.json({ ok: true, linkCode: code, expiresAt: expiresAt.toISOString(), botUsername: user, deepLink: user ? `https://t.me/${user}?start=${code}` : null });
    }
    case "telegram_unlink":
      await updateFounderSettings({ telegramChatId: null, telegramLinkCodeHash: null, telegramLinkCodeExpiresAt: null });
      return Response.json({ ok: true });
    case "set_whatsapp": {
      if (b.to === null || b.to.trim() === "") { await updateFounderSettings({ whatsappTo: null }); return Response.json({ ok: true, to: maskPhone(resolveWhatsAppTo(await getFounderSettings())) }); }
      const to = normalizeWhatsAppNumber(b.to);
      if (!to) return jsonError(400, "Enter the number in international format, e.g. +14155551234.");
      await updateFounderSettings({ whatsappTo: to });
      return Response.json({ ok: true, to: maskPhone(to) });
    }
    case "test": {
      const rl = await rateLimit(`notify-test:${auth.viewer.email}`, 5, 600);
      if (!rl.ok) return jsonError(429, "Too many test messages; wait a few minutes.", { retryAfter: rl.retryAfter });
      const results = await sendFounderText("Test from Standard Evals: founder notifications are working. Approvals and the daily report will arrive here.", { subject: "Standard Evals test notification", emailAlways: true });
      return Response.json({ ok: true, results });
    }
    case "decide": {
      const r = await decideApproval({ id: b.id, decision: b.decision, via: "console", actor: auth.viewer.email });
      if (r.status === "not_found") return jsonError(404, r.message);
      return Response.json({ ok: r.ok, status: r.status, note: r.message, changed: r.changed });
    }
  }
}

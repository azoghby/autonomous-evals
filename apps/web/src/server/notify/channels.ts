import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { isEmailConfigured, sendEmail } from "@ae/core/auth/email";
import { signToken } from "../owner-policy";
import { appUrl } from "../owner-shared";
import { EMAIL_LINK_TTL_MS } from "./approvals-logic";
import { founderRecipients } from "./founder-email-logic";
import { recordFounderThread } from "./founder-email";
import { sendTelegramApproval, sendTelegramText, telegramConfigured } from "./telegram";
import { formatWhatsAppApproval, normalizeWhatsAppNumber, sendWhatsApp, twilioConfigured } from "./whatsapp";
import type { ApprovalMessage, Env } from "./types";

/**
 * Founder channel selection + fan-out. Every channel is optional: unconfigured channels are skipped,
 * and a failing channel never blocks the others or the caller (all errors are caught and reported per channel).
 */

export const SETTINGS_ID = "founder";
export const LINK_CODE_TTL_MS = 15 * 60 * 1000;
export const DECIDE_PATH = "/notify/decide";

export type Channel = "telegram" | "whatsapp" | "email";
export type ChannelResults = Partial<Record<Channel, string>>;

export interface FounderSettings {
  telegramChatId: string | null;
  whatsappTo: string | null;
  telegramLinkCodeHash: string | null;
  telegramLinkCodeExpiresAt: Date | null;
}

const EMPTY: FounderSettings = { telegramChatId: null, whatsappTo: null, telegramLinkCodeHash: null, telegramLinkCodeExpiresAt: null };

export async function getFounderSettings(): Promise<FounderSettings> {
  const [row] = await db().select().from(schema.founderNotifySettings).where(eq(schema.founderNotifySettings.id, SETTINGS_ID)).limit(1);
  return row ? { telegramChatId: row.telegramChatId, whatsappTo: row.whatsappTo, telegramLinkCodeHash: row.telegramLinkCodeHash, telegramLinkCodeExpiresAt: row.telegramLinkCodeExpiresAt } : EMPTY;
}

export async function updateFounderSettings(patch: Partial<FounderSettings>): Promise<void> {
  const t = schema.founderNotifySettings;
  await db().insert(t).values({ id: SETTINGS_ID, ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({ target: t.id, set: { ...patch, updatedAt: new Date() } });
}

/** DB binding wins; env vars are a fallback for operators who prefer config. */
export function resolveTelegramChat(s: FounderSettings, env: Env = process.env): string | null {
  return s.telegramChatId ?? (env.TELEGRAM_FOUNDER_CHAT_ID?.trim() || null);
}
export function resolveWhatsAppTo(s: FounderSettings, env: Env = process.env): string | null {
  const raw = s.whatsappTo ?? env.FOUNDER_WHATSAPP_TO ?? null;
  return raw ? normalizeWhatsAppNumber(raw) : null;
}

export const hashLinkCode = (code: string) => createHash("sha256").update(`tg-link:${code}`).digest("hex");

/** Creates a fresh one-time Telegram link code (stored hashed, 15 min). Returns the plaintext code once. */
export async function createTelegramLinkCode(now = new Date()): Promise<{ code: string; expiresAt: Date }> {
  const code = randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase().padEnd(8, "X");
  const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_MS);
  await updateFounderSettings({ telegramLinkCodeHash: hashLinkCode(code), telegramLinkCodeExpiresAt: expiresAt });
  return { code, expiresAt };
}

/** Binds the chat when the /start code matches an unexpired code. Single-use: the code is cleared on success. */
export async function bindTelegramChat(code: string | null, chatId: string, now = new Date()): Promise<boolean> {
  if (!code) return false;
  const s = await getFounderSettings();
  if (!s.telegramLinkCodeHash || !s.telegramLinkCodeExpiresAt || s.telegramLinkCodeExpiresAt.getTime() <= now.getTime()) return false;
  const a = Buffer.from(hashLinkCode(code.toUpperCase())), b = Buffer.from(s.telegramLinkCodeHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  await updateFounderSettings({ telegramChatId: chatId, telegramLinkCodeHash: null, telegramLinkCodeExpiresAt: null });
  return true;
}

export function decisionLink(approvalId: string, d: "approve" | "reject", now = Date.now()): string {
  const t = signToken("founder_decision", { aid: approvalId, d, exp: now + EMAIL_LINK_TTL_MS });
  return `${appUrl()}${DECIDE_PATH}?t=${encodeURIComponent(t)}`;
}

export function buildApprovalEmail(msg: ApprovalMessage, approvalId: string, now = Date.now()): { subject: string; text: string } {
  const lines = [`#${msg.seq} ${msg.title}`, "", msg.summary, ""];
  if (msg.actions) {
    lines.push(`${msg.actions.approveLabel} (opens a confirmation page; nothing happens until you confirm):`, decisionLink(approvalId, "approve", now), "");
    if (msg.actions.rejectLabel) lines.push(`${msg.actions.rejectLabel}:`, decisionLink(approvalId, "reject", now), "");
    lines.push("Links expire in 24 hours and work once.", "");
  } else lines.push("(FYI, no action needed.)", "");
  lines.push(`View: ${msg.viewUrl}`);
  if (msg.actions) lines.push("", `Or just reply to this email: YES to ${msg.actions.approveLabel.toLowerCase()}, NO to reject (YES ${msg.seq} / NO ${msg.seq} also work).`);
  return { subject: msg.actions ? `[Approve #${msg.seq}] ${msg.title}` : `[FYI] ${msg.title}`, text: lines.join("\n") };
}

async function settle(results: ChannelResults, ch: Channel, fn: () => Promise<unknown>) {
  try { await fn(); results[ch] = "sent"; }
  catch (err) {
    results[ch] = `error: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`;
    console.error("founder notify failed", ch, results[ch]);
  }
}

export interface DispatchOutcome { results: ChannelResults; telegram?: { chatId: string; messageId: number } }

/**
 * Sends one approval/FYI to every configured channel. Email is the fallback: it is used when no phone channel is
 * bound, or always when FOUNDER_NOTIFY_EMAIL=always.
 */
export async function dispatchApproval(msg: ApprovalMessage, approvalId: string, env: Env = process.env, opts: { skipEmail?: boolean } = {}): Promise<DispatchOutcome> {
  const s = await getFounderSettings();
  const out: DispatchOutcome = { results: {} };
  const chat = resolveTelegramChat(s, env), wa = resolveWhatsAppTo(s, env);
  if (telegramConfigured(env) && chat) {
    await settle(out.results, "telegram", async () => { const r = await sendTelegramApproval(chat, msg); out.telegram = { chatId: chat, messageId: r.messageId }; });
  } else out.results.telegram = "skipped: not configured";
  if (twilioConfigured(env) && wa) await settle(out.results, "whatsapp", () => sendWhatsApp(wa, formatWhatsAppApproval(msg)));
  else out.results.whatsapp = "skipped: not configured";
  const phoneSent = out.results.telegram === "sent" || out.results.whatsapp === "sent";
  if (opts.skipEmail) out.results.email = "skipped: caller emails separately";
  else if (isEmailConfigured() && founderRecipients(env).length > 0 && (!phoneSent || env.FOUNDER_NOTIFY_EMAIL === "always")) {
    const { subject, text } = buildApprovalEmail(msg, approvalId);
    await settle(out.results, "email", async () => {
      // Commercial inbox: replies come back through the AgentMail inbound webhook (see founder-email.ts).
      for (const to of founderRecipients(env)) {
        const sent = await sendEmail({ to, subject, text, purpose: "commercial", labels: ["founder-approval"] });
        await recordFounderThread(sent.threadId, "approval", approvalId);
      }
    });
  } else out.results.email = phoneSent ? "skipped: phone channel delivered" : "skipped: not configured";
  return out;
}

/** Plain text (daily report, test message, decision confirmations) to every configured channel. */
export async function sendFounderText(text: string, opts: { subject: string; emailAlways?: boolean; threadKind?: "report"; draftIds?: string[] } = { subject: "Standard Evals" }, env: Env = process.env): Promise<ChannelResults> {
  const s = await getFounderSettings();
  const results: ChannelResults = {};
  const chat = resolveTelegramChat(s, env), wa = resolveWhatsAppTo(s, env);
  if (telegramConfigured(env) && chat) await settle(results, "telegram", () => sendTelegramText(chat, text));
  else results.telegram = "skipped: not configured";
  if (twilioConfigured(env) && wa) await settle(results, "whatsapp", () => sendWhatsApp(wa, text.slice(0, 1500)));
  else results.whatsapp = "skipped: not configured";
  const phoneSent = results.telegram === "sent" || results.whatsapp === "sent";
  if (isEmailConfigured() && founderRecipients(env).length > 0 && (opts.emailAlways || !phoneSent || env.FOUNDER_NOTIFY_EMAIL === "always")) {
    await settle(results, "email", async () => {
      for (const to of founderRecipients(env)) {
        const sent = await sendEmail({ to, subject: opts.subject, text, purpose: "commercial", labels: ["founder-notify"] });
        if (opts.threadKind) await recordFounderThread(sent.threadId, opts.threadKind, undefined, opts.draftIds);
      }
    });
  } else results.email = phoneSent ? "skipped: phone channel delivered" : "skipped: not configured";
  return results;
}

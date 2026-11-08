import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { truncate, type ApprovalMessage, type Decision, type Env, type FetchLike } from "./types";

const API_BASE = "https://api.telegram.org";

interface ApiOpts { env?: Env; fetchImpl?: FetchLike }

export function telegramConfigured(env: Env = process.env): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET);
}

export function verifyTelegramSecret(headerValue: string | null, env: Env = process.env): boolean {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || !headerValue) return false;
  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function telegramApi<T = unknown>(method: string, body: Record<string, unknown>, opts: ApiOpts = {}): Promise<T> {
  const env = opts.env ?? process.env;
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error(`telegram ${method} failed: bot token not configured`);
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init) as ReturnType<FetchLike>);
  let status = 0;
  type ApiJson = { ok?: boolean; result?: unknown; description?: string };
  const box: { json: ApiJson | null } = { json: null };
  try {
    const res = await doFetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    status = res.status;
    box.json = (await res.json().catch(() => null)) as ApiJson | null;
    if (res.ok && box.json?.ok === true) return box.json.result as T;
  } catch {
    // Network errors may embed the URL (and so the token); never propagate the raw error.
    throw new Error(`telegram ${method} failed: network error`);
  }
  const description = typeof box.json?.description === "string" ? box.json.description : "unknown error";
  throw new Error(`telegram ${method} failed: ${status} ${description.split(token).join("[redacted]")}`);
}

export function callbackData(decision: Decision, seq: number): string {
  return `d:${decision === "approve" ? "a" : "r"}:${seq}`;
}

const CALLBACK_RE = /^d:(a|r):(\d{1,9})$/;

export function parseCallbackData(data: string): { decision: Decision; seq: number } | null {
  const m = CALLBACK_RE.exec(data);
  if (!m) return null;
  return { decision: m[1] === "a" ? "approve" : "reject", seq: Number(m[2]) };
}

export function approvalKeyboard(msg: ApprovalMessage): { inline_keyboard: Array<Array<Record<string, string>>> } {
  const rows: Array<Array<Record<string, string>>> = [];
  if (msg.actions) {
    const row: Array<Record<string, string>> = [
      { text: msg.actions.approveLabel, callback_data: callbackData("approve", msg.seq) },
    ];
    if (msg.actions.rejectLabel) row.push({ text: msg.actions.rejectLabel, callback_data: callbackData("reject", msg.seq) });
    rows.push(row);
  }
  rows.push([{ text: "View", url: msg.viewUrl }]);
  return { inline_keyboard: rows };
}

export function formatApprovalText(msg: ApprovalMessage): string {
  return truncate(`#${msg.seq} ${msg.title}\n\n${msg.summary}${msg.actions ? "" : "\n\n(FYI)"}`);
}

async function sendMessage(chatId: string, text: string, extra: Record<string, unknown>, opts?: ApiOpts): Promise<{ messageId: number }> {
  const r = await telegramApi<{ message_id: number }>("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true, ...extra }, opts);
  return { messageId: r.message_id };
}

export function sendTelegramApproval(chatId: string, msg: ApprovalMessage, opts?: ApiOpts): Promise<{ messageId: number }> {
  return sendMessage(chatId, formatApprovalText(msg), { reply_markup: approvalKeyboard(msg) }, opts);
}

export function sendTelegramText(chatId: string, text: string, opts?: ApiOpts): Promise<{ messageId: number }> {
  return sendMessage(chatId, truncate(text), {}, opts);
}

export async function answerTelegramCallback(callbackQueryId: string, text: string, opts?: ApiOpts): Promise<void> {
  await telegramApi("answerCallbackQuery", { callback_query_id: callbackQueryId, text: truncate(text, 200) }, opts);
}

export async function markTelegramDecided(chatId: string, messageId: number, note: string, opts?: ApiOpts): Promise<void> {
  await telegramApi("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }, opts);
  await telegramApi("sendMessage", { chat_id: chatId, text: truncate(note), reply_to_message_id: messageId }, opts);
}

export type TelegramInbound =
  | { type: "start"; chatId: string; code: string | null; fromUsername: string | null }
  | { type: "decision"; chatId: string; callbackQueryId: string; messageId: number | null; decision: Decision; seq: number }
  | { type: "text"; chatId: string; text: string }
  | { type: "ignored" };

const idSchema = z.union([z.number(), z.string()]).transform(String);
const chatSchema = z.object({ id: idSchema, type: z.string() });
const messageSchema = z.object({
  chat: chatSchema,
  text: z.string().optional(),
  from: z.object({ username: z.string().optional() }).optional(),
});
const updateSchema = z.object({
  message: messageSchema.optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().optional(),
      message: z.object({ message_id: z.number().optional(), chat: chatSchema }).optional(),
    })
    .optional(),
});

const IGNORED: TelegramInbound = { type: "ignored" };
const START_RE = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/;
const CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;

export function parseTelegramUpdate(update: unknown): TelegramInbound {
  const parsed = updateSchema.safeParse(update);
  if (!parsed.success) return IGNORED;
  const { message, callback_query: cb } = parsed.data;

  if (cb) {
    const decoded = cb.data ? parseCallbackData(cb.data) : null;
    if (!decoded || !cb.message) return IGNORED;
    return {
      type: "decision",
      chatId: cb.message.chat.id,
      callbackQueryId: cb.id,
      messageId: cb.message.message_id ?? null,
      ...decoded,
    };
  }

  if (message && message.chat.type === "private" && message.text) {
    const text = message.text.trim();
    const start = START_RE.exec(text);
    if (start) {
      const raw = start[1];
      return { type: "start", chatId: message.chat.id, code: raw && CODE_RE.test(raw) ? raw : null, fromUsername: message.from?.username ?? null };
    }
    return { type: "text", chatId: message.chat.id, text };
  }
  return IGNORED;
}

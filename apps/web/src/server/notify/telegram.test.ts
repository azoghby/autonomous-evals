import { describe, expect, it, vi } from "vitest";
import {
  answerTelegramCallback, approvalKeyboard, callbackData, formatApprovalText, markTelegramDecided,
  parseCallbackData, parseTelegramUpdate, sendTelegramApproval, telegramApi, telegramConfigured, verifyTelegramSecret,
} from "./telegram";
import type { ApprovalMessage, FetchLike } from "./types";

const TOKEN = "123456:SECRET-TOKEN";
const env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: "whsec" };

function mockFetch(payload: unknown, ok = true, status = 200) {
  return vi.fn(async () => ({ ok, status, json: async () => payload, text: async () => JSON.stringify(payload) }));
}
const asFetch = (f: ReturnType<typeof mockFetch>) => f as unknown as FetchLike;
const callsOf = (f: ReturnType<typeof mockFetch>) => f.mock.calls as unknown as Array<[string, { method: string; body: string }]>;

const base: ApprovalMessage = {
  seq: 7, kind: "x", title: "Deploy", summary: "Ship it?", viewUrl: "https://app.test/op/7",
  actions: { approveLabel: "Approve", rejectLabel: "Reject" },
};

describe("telegramApi", () => {
  it("POSTs JSON to the bot URL and returns result", async () => {
    const f = mockFetch({ ok: true, result: { message_id: 5 } });
    const r = await telegramApi("sendMessage", { chat_id: "1" }, { env, fetchImpl: asFetch(f) });
    expect(r).toEqual({ message_id: 5 });
    const [url, init] = callsOf(f)[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ chat_id: "1" });
  });

  it("throws without leaking the token", async () => {
    const f = mockFetch({ ok: false, description: `Bad Request: bot${TOKEN} chat not found` }, false, 400);
    const err = await telegramApi("sendMessage", {}, { env, fetchImpl: asFetch(f) }).catch((e: Error) => e);
    expect((err as Error).message).toContain("telegram sendMessage failed: 400");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("throws when json.ok is not true even on HTTP 200", async () => {
    const f = mockFetch({ ok: false, description: "nope" });
    await expect(telegramApi("x", {}, { env, fetchImpl: asFetch(f) })).rejects.toThrow("telegram x failed: 200 nope");
  });

  it("does not leak the token from network errors", async () => {
    const f = vi.fn(async () => { throw new Error(`fetch failed for bot${TOKEN}`); });
    const err = await telegramApi("x", {}, { env, fetchImpl: f as unknown as FetchLike }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(TOKEN);
  });
});

describe("keyboard and text", () => {
  it("has approve, reject and View", () => {
    expect(approvalKeyboard(base).inline_keyboard).toEqual([
      [{ text: "Approve", callback_data: "d:a:7" }, { text: "Reject", callback_data: "d:r:7" }],
      [{ text: "View", url: base.viewUrl }],
    ]);
  });
  it("omits reject when no rejectLabel", () => {
    const kb = approvalKeyboard({ ...base, actions: { approveLabel: "OK", rejectLabel: null } });
    expect(kb.inline_keyboard[0]).toEqual([{ text: "OK", callback_data: "d:a:7" }]);
  });
  it("FYI has only View", () => {
    const fyi = { ...base, actions: null };
    expect(approvalKeyboard(fyi).inline_keyboard).toEqual([[{ text: "View", url: base.viewUrl }]]);
    expect(formatApprovalText(fyi)).toBe("#7 Deploy\n\nShip it?\n\n(FYI)");
  });
  it("formats decision text without FYI marker", () => {
    expect(formatApprovalText(base)).toBe("#7 Deploy\n\nShip it?");
  });
});

describe("senders", () => {
  it("sendTelegramApproval returns messageId and sends reply_markup", async () => {
    const f = mockFetch({ ok: true, result: { message_id: 42 } });
    expect(await sendTelegramApproval("9", base, { env, fetchImpl: asFetch(f) })).toEqual({ messageId: 42 });
    const body = JSON.parse(callsOf(f)[0][1].body);
    expect(body.chat_id).toBe("9");
    expect(body.reply_markup.inline_keyboard).toHaveLength(2);
    expect(body.disable_web_page_preview).toBe(true);
  });
  it("answerTelegramCallback calls answerCallbackQuery", async () => {
    const f = mockFetch({ ok: true, result: true });
    await answerTelegramCallback("cb1", "Done", { env, fetchImpl: asFetch(f) });
    expect(callsOf(f)[0][0]).toContain("/answerCallbackQuery");
  });
  it("markTelegramDecided removes keyboard then replies", async () => {
    const f = mockFetch({ ok: true, result: true });
    await markTelegramDecided("9", 42, "Approved", { env, fetchImpl: asFetch(f) });
    const calls = callsOf(f);
    expect(calls[0][0]).toContain("/editMessageReplyMarkup");
    expect(JSON.parse(calls[0][1].body).reply_markup).toEqual({ inline_keyboard: [] });
    expect(calls[1][0]).toContain("/sendMessage");
    expect(JSON.parse(calls[1][1].body).reply_to_message_id).toBe(42);
  });
});

describe("callback data", () => {
  it("round-trips", () => {
    expect(callbackData("approve", 12)).toBe("d:a:12");
    expect(parseCallbackData(callbackData("reject", 999))).toEqual({ decision: "reject", seq: 999 });
    expect(parseCallbackData("d:a:12")).toEqual({ decision: "approve", seq: 12 });
  });
  it.each(["d:x:1", "d:a:", "d:a:1;drop", "d:a:1234567890", "", "xd:a:1", "d:a:1\n"])("rejects %j", (s) => {
    expect(parseCallbackData(s)).toBeNull();
  });
});

describe("parseTelegramUpdate", () => {
  const msg = (text: string, type = "private") => ({ message: { chat: { id: 55, type }, text, from: { username: "ron" } } });
  it("parses /start code", () => {
    expect(parseTelegramUpdate(msg("/start abc123"))).toEqual({ type: "start", chatId: "55", code: "abc123", fromUsername: "ron" });
  });
  it("parses /start@Bot code", () => {
    expect(parseTelegramUpdate(msg("/start@MyBot abc_123-X"))).toMatchObject({ type: "start", code: "abc_123-X" });
  });
  it("bare /start has null code", () => {
    expect(parseTelegramUpdate(msg("/start"))).toMatchObject({ type: "start", code: null });
  });
  it("bad code yields null", () => {
    expect(parseTelegramUpdate(msg("/start a!"))).toMatchObject({ type: "start", code: null });
    expect(parseTelegramUpdate(msg("/start abc"))).toMatchObject({ type: "start", code: null });
  });
  it("ignores group chats", () => {
    expect(parseTelegramUpdate(msg("/start abc123", "group"))).toEqual({ type: "ignored" });
    expect(parseTelegramUpdate(msg("hi", "supergroup"))).toEqual({ type: "ignored" });
  });
  it("parses plain text", () => {
    expect(parseTelegramUpdate(msg("YES 12"))).toEqual({ type: "text", chatId: "55", text: "YES 12" });
  });
  it("parses callback decision", () => {
    const u = { callback_query: { id: "q1", data: "d:a:3", message: { message_id: 8, chat: { id: -100, type: "private" } } } };
    expect(parseTelegramUpdate(u)).toEqual({ type: "decision", chatId: "-100", callbackQueryId: "q1", messageId: 8, decision: "approve", seq: 3 });
  });
  it("ignores bad callback data", () => {
    const u = { callback_query: { id: "q1", data: "zzz", message: { message_id: 8, chat: { id: 1, type: "private" } } } };
    expect(parseTelegramUpdate(u)).toEqual({ type: "ignored" });
  });
  it.each([null, "str", {}, 5, [], { message: 3 }])("ignores garbage %j", (g) => {
    expect(parseTelegramUpdate(g)).toEqual({ type: "ignored" });
  });
});

describe("secrets", () => {
  it("verifyTelegramSecret", () => {
    expect(verifyTelegramSecret("whsec", env)).toBe(true);
    expect(verifyTelegramSecret("wrong!", env)).toBe(false);
    expect(verifyTelegramSecret("whsecX", env)).toBe(false);
    expect(verifyTelegramSecret(null, env)).toBe(false);
    expect(verifyTelegramSecret("whsec", {})).toBe(false);
  });
  it("telegramConfigured", () => {
    expect(telegramConfigured(env)).toBe(true);
    expect(telegramConfigured({ TELEGRAM_BOT_TOKEN: "x" })).toBe(false);
    expect(telegramConfigured({})).toBe(false);
  });
});

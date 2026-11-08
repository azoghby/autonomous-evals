import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  decideApproval: vi.fn(),
  getFounderSettings: vi.fn(async () => ({})),
  resolveTelegramChat: vi.fn((): string | null => "111"),
  bindTelegramChat: vi.fn(async () => true),
  answerTelegramCallback: vi.fn(async () => undefined),
  sendTelegramText: vi.fn(async () => ({ messageId: 1 })),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/server/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/server/notify/approvals", () => ({ decideApproval: m.decideApproval }));
vi.mock("@/server/notify/channels", () => ({
  getFounderSettings: m.getFounderSettings,
  resolveTelegramChat: m.resolveTelegramChat,
  bindTelegramChat: m.bindTelegramChat,
}));
vi.mock("@/server/notify/telegram", async () => ({
  ...(await vi.importActual<typeof import("@/server/notify/telegram")>("@/server/notify/telegram")),
  answerTelegramCallback: m.answerTelegramCallback,
  sendTelegramText: m.sendTelegramText,
}));
import { POST } from "./route";

const SECRET = "whsec-123";
const post = (body: unknown, secret: string | null = SECRET, raw = false) =>
  POST(new Request("http://localhost/api/notify/telegram", {
    method: "POST",
    headers: secret === null ? {} : { "x-telegram-bot-api-secret-token": secret },
    body: raw ? (body as string) : JSON.stringify(body),
  }));
const cb = (chat: string | number, data: string) => ({
  callback_query: { id: "cbq1", data, message: { message_id: 5, chat: { id: chat, type: "private" } } },
});
const msg = (chat: string | number, text: string) => ({ message: { chat: { id: chat, type: "private" }, text } });

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "bot-token");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", SECRET);
  Object.values(m).forEach((f) => f.mockClear());
  m.resolveTelegramChat.mockReturnValue("111");
  m.bindTelegramChat.mockResolvedValue(true);
  m.decideApproval.mockResolvedValue({ ok: true, changed: true, status: "approved", message: "#12 approved." });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("telegram webhook", () => {
  it("401 on missing or wrong secret header, never deciding", async () => {
    expect((await post(cb(111, "d:a:12"), null)).status).toBe(401);
    expect((await post(cb(111, "d:a:12"), "wrong")).status).toBe(401);
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("404 when TELEGRAM_BOT_TOKEN is unset", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    expect((await post(cb(111, "d:a:12"))).status).toBe(404);
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("/start <code> binds the chat and replies", async () => {
    m.resolveTelegramChat.mockReturnValue(null);
    const res = await post(msg(222, "/start abcd1234"));
    expect(res.status).toBe(200);
    expect(m.bindTelegramChat).toHaveBeenCalledWith("abcd1234", "222");
    expect(m.sendTelegramText).toHaveBeenCalledWith("222", expect.stringContaining("Linked"));
  });

  it("/start with a bad code replies with an invalid-code message", async () => {
    m.resolveTelegramChat.mockReturnValue(null);
    m.bindTelegramChat.mockResolvedValue(false);
    await post(msg(222, "/start abcd1234"));
    expect(m.sendTelegramText).toHaveBeenCalledWith("222", expect.stringContaining("invalid or expired"));
  });

  it("callback from the bound chat decides and answers the callback", async () => {
    const res = await post(cb(111, "d:a:12"));
    expect(res.status).toBe(200);
    expect(m.decideApproval).toHaveBeenCalledWith({ seq: 12, decision: "approve", via: "telegram" });
    expect(m.answerTelegramCallback).toHaveBeenCalledWith("cbq1", "#12 approved.");
    expect(m.sendTelegramText).not.toHaveBeenCalled();
  });

  it("reject callback maps to reject", async () => {
    await post(cb(111, "d:r:3"));
    expect(m.decideApproval).toHaveBeenCalledWith({ seq: 3, decision: "reject", via: "telegram" });
  });

  it("callback from a different chat is refused", async () => {
    const res = await post(cb(999, "d:a:12"));
    expect(res.status).toBe(200);
    expect(m.decideApproval).not.toHaveBeenCalled();
    expect(m.answerTelegramCallback).toHaveBeenCalledWith("cbq1", "Not authorized.");
  });

  it("no founder bound at all: refuses decisions", async () => {
    m.resolveTelegramChat.mockReturnValue(null);
    await post(cb(111, "d:a:12"));
    expect(m.decideApproval).not.toHaveBeenCalled();
    expect(m.answerTelegramCallback).toHaveBeenCalledWith("cbq1", "Not authorized.");
  });

  it("text 'YES 12' from the bound chat decides", async () => {
    const res = await post(msg(111, "YES 12"));
    expect(res.status).toBe(200);
    expect(m.decideApproval).toHaveBeenCalledWith({ seq: 12, decision: "approve", via: "telegram" });
  });

  it("text from a different chat does not decide", async () => {
    await post(msg(999, "YES 12"));
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("unparseable text from the bound chat sends help, no decision", async () => {
    await post(msg(111, "hello there"));
    expect(m.decideApproval).not.toHaveBeenCalled();
    expect(m.sendTelegramText).toHaveBeenCalledWith("111", expect.stringContaining("YES <n>"));
  });

  it("malformed JSON returns 200 with no decision", async () => {
    const res = await post("{not json", SECRET, true);
    expect(res.status).toBe(200);
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("double tap: changed:false still 200 and sends the no-op message", async () => {
    m.decideApproval.mockResolvedValue({ ok: false, changed: false, status: "approved", message: "#12 was already approved. Nothing changed." });
    const res = await post(cb(111, "d:a:12"));
    expect(res.status).toBe(200);
    expect(m.answerTelegramCallback).toHaveBeenCalledWith("cbq1", "#12 was already approved. Nothing changed.");
    expect(m.sendTelegramText).toHaveBeenCalledWith("111", "#12 was already approved. Nothing changed.");
  });

  it("swallows handler errors with a 200 (no retry storm)", async () => {
    m.decideApproval.mockRejectedValue(new Error("db down"));
    expect((await post(cb(111, "d:a:12"))).status).toBe(200);
  });
});

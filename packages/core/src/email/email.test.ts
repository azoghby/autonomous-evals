import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

const agentSend = vi.fn(async () => ({ messageId: "m1", threadId: "t1" }));
const resendSend = vi.fn(async () => ({ data: { id: "r1" }, error: null }));
vi.mock("agentmail", () => ({
  AgentMailClient: class { inboxes = { messages: { send: agentSend, reply: vi.fn() } }; },
}));
vi.mock("resend", () => ({ Resend: class { emails = { send: resendSend }; } }));

import { sendEmail, isEmailConfigured } from "../auth/email";
import { verifyWebhookSignature, parseInboundEvent } from "./webhook";

const ENV_KEYS = ["AGENTMAIL_API_KEY", "AGENTMAIL_COMMERCIAL_INBOX_ID", "AGENTMAIL_AUTH_INBOX_ID", "RESEND_API_KEY", "EMAIL_FROM"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => { ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); vi.clearAllMocks(); });
afterEach(() => { ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

const base = { to: "a@example.com", subject: "s", text: "t" };

describe("sendEmail routing", () => {
  beforeEach(() => {
    process.env.AGENTMAIL_API_KEY = "k";
    process.env.AGENTMAIL_COMMERCIAL_INBOX_ID = "commercial@agentmail.to";
    process.env.AGENTMAIL_AUTH_INBOX_ID = "auth@agentmail.to";
  });
  it("defaults to the commercial inbox and returns the thread id", async () => {
    const r = await sendEmail(base);
    expect(agentSend).toHaveBeenCalledWith("commercial@agentmail.to", expect.objectContaining({ to: "a@example.com", subject: "s" }));
    expect(r).toEqual({ id: "m1", threadId: "t1" });
  });
  it("uses the auth inbox for purpose auth", async () => {
    await sendEmail({ ...base, purpose: "auth" });
    expect(agentSend).toHaveBeenCalledWith("auth@agentmail.to", expect.anything());
  });
  it("auth falls back to the commercial inbox when no auth inbox is set", async () => {
    delete process.env.AGENTMAIL_AUTH_INBOX_ID;
    await sendEmail({ ...base, purpose: "auth" });
    expect(agentSend).toHaveBeenCalledWith("commercial@agentmail.to", expect.anything());
  });
  it("throws when AgentMail is configured but no inbox id exists", async () => {
    delete process.env.AGENTMAIL_COMMERCIAL_INBOX_ID;
    await expect(sendEmail(base)).rejects.toThrow(/INBOX_ID/);
  });
});

describe("sendEmail fallback", () => {
  it("falls back to Resend only when AGENTMAIL_API_KEY is absent", async () => {
    process.env.RESEND_API_KEY = "rk"; process.env.EMAIL_FROM = "x@y.z";
    const r = await sendEmail(base);
    expect(resendSend).toHaveBeenCalledOnce();
    expect(agentSend).not.toHaveBeenCalled();
    expect(r).toEqual({ id: "r1" });
  });
  it("throws with no transport at all, and reports unconfigured", async () => {
    expect(isEmailConfigured()).toBe(false);
    await expect(sendEmail(base)).rejects.toThrow(/No email transport/);
  });
  it("AgentMail alone counts as configured (disables dev links in prod)", () => {
    process.env.AGENTMAIL_API_KEY = "k";
    expect(isEmailConfigured()).toBe(true);
  });
});

describe("webhook signature", () => {
  const secret = "whsec_" + Buffer.from("super-secret-key").toString("base64");
  const body = JSON.stringify({ hello: "world" });
  const now = 1_700_000_000_000;
  const ts = String(now / 1000);
  const sign = (id: string, t: string, b: string) =>
    "v1," + createHmac("sha256", Buffer.from("super-secret-key")).update(`${id}.${t}.${b}`).digest("base64");

  it("accepts a valid signature", () => {
    expect(verifyWebhookSignature(body, { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) }, secret, now)).toBe(true);
  });
  it("accepts when one of several signatures matches", () => {
    expect(verifyWebhookSignature(body, { id: "msg_1", timestamp: ts, signature: `v1,AAAA ${sign("msg_1", ts, body)}` }, secret, now)).toBe(true);
  });
  it("rejects a tampered body, wrong secret, missing headers, and stale timestamps", () => {
    const h = { id: "msg_1", timestamp: ts, signature: sign("msg_1", ts, body) };
    expect(verifyWebhookSignature(body + " ", h, secret, now)).toBe(false);
    expect(verifyWebhookSignature(body, h, "whsec_" + Buffer.from("other").toString("base64"), now)).toBe(false);
    expect(verifyWebhookSignature(body, { ...h, signature: null }, secret, now)).toBe(false);
    expect(verifyWebhookSignature(body, h, undefined, now)).toBe(false);
    expect(verifyWebhookSignature(body, h, secret, now + 10 * 60 * 1000)).toBe(false);
  });
});

describe("parseInboundEvent", () => {
  it("normalizes snake_case and camelCase payloads", () => {
    const snake = parseInboundEvent({ event_type: "message.received", message: { inbox_id: "i", thread_id: "t", message_id: "m", from_: ["A <a@b.c>"], subject: "s", text: "hi" } });
    const camel = parseInboundEvent({ eventType: "message.received", message: { inboxId: "i", threadId: "t", messageId: "m", from: "A <a@b.c>", subject: "s", extractedText: "hi" } });
    expect(snake).toEqual(camel);
    expect(snake?.text).toBe("hi");
  });
  it("returns null for junk", () => {
    expect(parseInboundEvent(null)).toBeNull();
    expect(parseInboundEvent({ message: {} })).toBeNull();
  });
});

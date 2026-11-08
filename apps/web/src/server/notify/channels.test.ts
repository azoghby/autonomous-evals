import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ae/core/db/client", () => ({ db: vi.fn(), schema: {} }));
vi.mock("@ae/core/auth/email", () => ({ isEmailConfigured: () => false, sendEmail: vi.fn() }));

import { verifySignedToken } from "../owner-policy";
import { buildApprovalEmail, hashLinkCode, resolveTelegramChat, resolveWhatsAppTo } from "./channels";
import { parseDecisionToken } from "./approvals-logic";
import type { ApprovalMessage } from "./types";

const aid = "0b6c2f4e-8a1d-4c3b-9f2e-1a2b3c4d5e6f";
const msg: ApprovalMessage = { seq: 12, kind: "outreach_draft", title: "Expert invite", summary: "Draft to j***@acme.io", viewUrl: "https://x/operator", actions: { approveLabel: "Approve & send", rejectLabel: "Reject" } };

beforeEach(() => { vi.stubEnv("SESSION_SECRET", "test-secret-test-secret-test-secret"); vi.stubEnv("APP_URL", "https://x"); });

describe("buildApprovalEmail", () => {
  it("contains signed approve + reject links to the confirm page (24h)", () => {
    const now = Date.now();
    const { subject, text } = buildApprovalEmail(msg, aid, now);
    expect(subject).toBe("[Approve?] #12 Expert invite");
    const links = [...text.matchAll(/https:\/\/x\/notify\/decide\?t=(\S+)/g)].map((m) => decodeURIComponent(m[1]!));
    expect(links).toHaveLength(2);
    const [a, r] = links.map((t) => parseDecisionToken(verifySignedToken("founder_decision", t)));
    expect(a).toMatchObject({ aid, d: "approve" });
    expect(r).toMatchObject({ aid, d: "reject" });
    expect(a!.exp - now).toBe(24 * 60 * 60 * 1000);
    // Purpose-bound: an approve_all verifier must not accept it.
    expect(verifySignedToken("approve_all", links[0]!)).toBeNull();
  });
  it("FYI email has no decision links", () => {
    const { subject, text } = buildApprovalEmail({ ...msg, actions: null }, aid);
    expect(subject.startsWith("[FYI]")).toBe(true);
    expect(text).not.toContain("/notify/decide");
  });
});

describe("channel resolution", () => {
  const s = { telegramChatId: null, whatsappTo: null, telegramLinkCodeHash: null, telegramLinkCodeExpiresAt: null };
  it("prefers the DB binding, falls back to env", () => {
    expect(resolveTelegramChat({ ...s, telegramChatId: "42" }, { TELEGRAM_FOUNDER_CHAT_ID: "7" })).toBe("42");
    expect(resolveTelegramChat(s, { TELEGRAM_FOUNDER_CHAT_ID: "7" })).toBe("7");
    expect(resolveTelegramChat(s, {})).toBeNull();
    expect(resolveWhatsAppTo(s, { FOUNDER_WHATSAPP_TO: "+1 415 555 1234" })).toBe("whatsapp:+14155551234");
    expect(resolveWhatsAppTo({ ...s, whatsappTo: "whatsapp:+447700900123" }, {})).toBe("whatsapp:+447700900123");
    expect(resolveWhatsAppTo(s, { FOUNDER_WHATSAPP_TO: "nope" })).toBeNull();
  });
  it("hashes link codes (never stores plaintext)", () => {
    expect(hashLinkCode("ABCD1234")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLinkCode("ABCD1234")).not.toBe(hashLinkCode("ABCD1235"));
  });
});

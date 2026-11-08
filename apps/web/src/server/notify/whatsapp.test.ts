import { describe, expect, it, vi } from "vitest";
import type { ApprovalMessage, FetchLike } from "./types";
import {
  TWILIO_EMPTY_TWIML,
  computeTwilioSignature,
  formParamsToRecord,
  formatWhatsAppApproval,
  normalizeWhatsAppNumber,
  parseWhatsAppReply,
  sendWhatsApp,
  twilioConfigured,
  twimlMessage,
  validateTwilioSignature,
} from "./whatsapp";

const env = { TWILIO_ACCOUNT_SID: "ACabc123", TWILIO_AUTH_TOKEN: "sekret-token", TWILIO_WHATSAPP_FROM: "+14155238886" };

function mockFetch(res: { ok: boolean; status: number; json: unknown }) {
  return vi.fn<FetchLike>(async () => ({
    ok: res.ok,
    status: res.status,
    json: async () => res.json,
    text: async () => JSON.stringify(res.json),
  }));
}

describe("twilioConfigured", () => {
  it("requires all three vars", () => {
    expect(twilioConfigured(env)).toBe(true);
    expect(twilioConfigured({ ...env, TWILIO_AUTH_TOKEN: "" })).toBe(false);
    expect(twilioConfigured({})).toBe(false);
  });
});

describe("normalizeWhatsAppNumber", () => {
  it.each([
    ["+14155551234", "whatsapp:+14155551234"],
    ["whatsapp:+14155551234", "whatsapp:+14155551234"],
    ["WhatsApp:+14155551234", "whatsapp:+14155551234"],
    [" +1 (415) 555-1234 ", "whatsapp:+14155551234"],
    ["14155551234", "whatsapp:+14155551234"],
  ])("accepts %s", (input, out) => expect(normalizeWhatsAppNumber(input)).toBe(out));

  it.each(["", "abc", "+1234567", "+1234567890123456", "+0123456789", "tel:+14155551234", "+1415x551234"])(
    "rejects %j",
    (input) => expect(normalizeWhatsAppNumber(input)).toBeNull(),
  );
});

describe("formatWhatsAppApproval", () => {
  const base: ApprovalMessage = {
    seq: 12,
    kind: "send_email",
    title: "Send outreach",
    summary: "3 emails to prospects",
    viewUrl: "https://app.example.com/operator/12",
    actions: { approveLabel: "Approve & send", rejectLabel: "Reject" },
  };
  it("includes reply instructions and view url", () => {
    expect(formatWhatsAppApproval(base)).toBe(
      "#12 Send outreach\n\n3 emails to prospects\n\nReply YES 12 (Approve & send) or NO 12 (Reject)\nView: https://app.example.com/operator/12",
    );
  });
  it("marks FYI when no actions", () => {
    expect(formatWhatsAppApproval({ ...base, actions: null })).toContain("\n\n(FYI)\nView: ");
  });
  it("omits NO when there is no reject label", () => {
    const out = formatWhatsAppApproval({ ...base, actions: { approveLabel: "Ok", rejectLabel: null } });
    expect(out).toContain("Reply YES 12 (Ok)\n");
    expect(out).not.toContain("NO 12");
  });
  it("truncates to 1500 chars", () => {
    expect(formatWhatsAppApproval({ ...base, summary: "x".repeat(5000) }).length).toBe(1500);
  });
});

describe("sendWhatsApp", () => {
  it("posts form-encoded body with basic auth to the Twilio messages endpoint", async () => {
    const f = mockFetch({ ok: true, status: 201, json: { sid: "SM123" } });
    const r = await sendWhatsApp("+1 (415) 555-1234", "hello & bye", { env, fetchImpl: f });
    expect(r).toEqual({ sid: "SM123" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/ACabc123/Messages.json");
    expect(init?.method).toBe("POST");
    expect(init?.headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(init?.headers?.Authorization).toBe(`Basic ${Buffer.from("ACabc123:sekret-token").toString("base64")}`);
    const form = new URLSearchParams(init?.body);
    expect(form.get("From")).toBe("whatsapp:+14155238886");
    expect(form.get("To")).toBe("whatsapp:+14155551234");
    expect(form.get("Body")).toBe("hello & bye");
  });

  it("throws with status and code/message on failure, without leaking the token", async () => {
    const f = mockFetch({ ok: false, status: 400, json: { code: 63016, message: "Outside window sekret-token" } });
    const err = await sendWhatsApp("+14155551234", "hi", { env, fetchImpl: f }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/^twilio send failed: 400 63016 Outside window/);
    expect(msg).not.toContain("sekret-token");
  });

  it("handles non-JSON error bodies", async () => {
    const f = vi.fn<FetchLike>(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error("bad json");
      },
      text: async () => "bad gateway",
    }));
    await expect(sendWhatsApp("+14155551234", "hi", { env, fetchImpl: f })).rejects.toThrow("twilio send failed: 502");
  });

  it("throws on an invalid recipient without calling fetch", async () => {
    const f = mockFetch({ ok: true, status: 201, json: { sid: "SM1" } });
    await expect(sendWhatsApp("not-a-number", "hi", { env, fetchImpl: f })).rejects.toThrow(/invalid/);
    expect(f).not.toHaveBeenCalled();
  });

  it("throws when not configured", async () => {
    const f = mockFetch({ ok: true, status: 201, json: { sid: "SM1" } });
    await expect(sendWhatsApp("+14155551234", "hi", { env: {}, fetchImpl: f })).rejects.toThrow(/not configured/);
  });
});

// Twilio's documented example (https://www.twilio.com/docs/usage/security): url below, auth token "12345".
// With Caller/From = +14158675310 the documented signature is "GvWf1cFY/Q7PnoempGyD5oXAezc=" (reproduced by
// this implementation). The param set in the task brief (+12349013030) yields a different value (not a
// published one), and the older doc value "RSOYDt4T1cUTdK1PDd93/VVr8B8=" belongs to another param set;
// so the brief's set is only checked for self-consistency.
const SIG_URL = "https://mycompany.com/myapp.php?foo=1&bar=2";
const SIG_PARAMS = {
  CallSid: "CA1234567890ABCDE",
  Caller: "+14158675310",
  Digits: "1234",
  From: "+14158675310",
  To: "+18005551212",
};
const SIG_EXPECTED = "GvWf1cFY/Q7PnoempGyD5oXAezc=";

describe("computeTwilioSignature / validateTwilioSignature", () => {
  it("matches Twilio's documented example", () => {
    expect(computeTwilioSignature(SIG_URL, SIG_PARAMS, "12345")).toBe(SIG_EXPECTED);
  });
  it("is independent of param insertion order", () => {
    const shuffled = Object.fromEntries(Object.entries(SIG_PARAMS).reverse());
    expect(computeTwilioSignature(SIG_URL, shuffled, "12345")).toBe(SIG_EXPECTED);
  });
  it("is deterministic and param-sensitive for the +12349013030 set", () => {
    const p = { ...SIG_PARAMS, Caller: "+12349013030", From: "+12349013030" };
    expect(computeTwilioSignature(SIG_URL, p, "12345")).toBe(computeTwilioSignature(SIG_URL, p, "12345"));
    expect(computeTwilioSignature(SIG_URL, p, "12345")).not.toBe(SIG_EXPECTED);
  });
  it("validates a correct signature", () => {
    expect(validateTwilioSignature(SIG_URL, SIG_PARAMS, SIG_EXPECTED, "12345")).toBe(true);
  });
  it("rejects missing signature or token", () => {
    expect(validateTwilioSignature(SIG_URL, SIG_PARAMS, null, "12345")).toBe(false);
    expect(validateTwilioSignature(SIG_URL, SIG_PARAMS, "", "12345")).toBe(false);
    expect(validateTwilioSignature(SIG_URL, SIG_PARAMS, SIG_EXPECTED, undefined)).toBe(false);
  });
  it("rejects wrong token, tampered param, tampered url, and wrong-length signature", () => {
    expect(validateTwilioSignature(SIG_URL, SIG_PARAMS, SIG_EXPECTED, "other")).toBe(false);
    expect(validateTwilioSignature(SIG_URL, { ...SIG_PARAMS, Digits: "9999" }, SIG_EXPECTED, "12345")).toBe(false);
    expect(validateTwilioSignature(`${SIG_URL}&x=1`, SIG_PARAMS, SIG_EXPECTED, "12345")).toBe(false);
    expect(validateTwilioSignature(SIG_URL, SIG_PARAMS, "short", "12345")).toBe(false);
  });
});

describe("parseWhatsAppReply", () => {
  it.each([
    ["YES 12", "approve", 12],
    ["yes12", "approve", 12],
    ["  Yes #12  ", "approve", 12],
    ["y 7", "approve", 7],
    ["APPROVE 3", "approve", 3],
    ["ok 5", "approve", 5],
    ["NO 12", "reject", 12],
    ["no#4", "reject", 4],
    ["n 9", "reject", 9],
    ["Reject 123456789", "reject", 123456789],
  ])("parses %j", (body, decision, seq) => expect(parseWhatsAppReply(body)).toEqual({ decision, seq }));

  it.each(["", "yes", "no", "12", "12 yes", "maybe 3", "yes 1234567890", "yes 12 please", "yes -1", "yes 1.5"])(
    "returns null for %j",
    (body) => expect(parseWhatsAppReply(body)).toBeNull(),
  );
});

describe("formParamsToRecord", () => {
  it("flattens URLSearchParams", () => {
    const f = new URLSearchParams("Body=YES+12&From=whatsapp%3A%2B14155551234");
    expect(formParamsToRecord(f)).toEqual({ Body: "YES 12", From: "whatsapp:+14155551234" });
  });
});

describe("TwiML", () => {
  it("has an empty response constant", () => {
    expect(TWILIO_EMPTY_TWIML).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });
  it("escapes XML special characters", () => {
    const out = twimlMessage(`a & b < c > d "e" 'f'`);
    expect(out).toContain("<Message>a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;</Message>");
    expect(out.startsWith("<?xml")).toBe(true);
    expect(out.endsWith("</Response>")).toBe(true);
  });
});

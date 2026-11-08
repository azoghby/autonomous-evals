import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  decideApproval: vi.fn(),
  getFounderSettings: vi.fn(async () => ({})),
  resolveWhatsAppTo: vi.fn((): string | null => "whatsapp:+14155551234"),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/server/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/server/notify/approvals", () => ({ decideApproval: m.decideApproval }));
vi.mock("@/server/notify/channels", () => ({ getFounderSettings: m.getFounderSettings, resolveWhatsAppTo: m.resolveWhatsAppTo }));
import { computeTwilioSignature } from "@/server/notify/whatsapp";
import { POST } from "./route";

const TOKEN = "twilio-auth-token";
const URL_ = "https://example.test/api/notify/whatsapp";
const FOUNDER = "whatsapp:+14155551234";

function req(params: Record<string, string>, opts: { sign?: Record<string, string> | false; signature?: string } = {}) {
  const sig = opts.signature ?? (opts.sign === false ? undefined : computeTwilioSignature(URL_, opts.sign ?? params, TOKEN));
  return new Request("http://localhost/api/notify/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(sig ? { "x-twilio-signature": sig } : {}) },
    body: new URLSearchParams(params).toString(),
  });
}
const EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

beforeEach(() => {
  vi.stubEnv("APP_URL", "https://example.test");
  vi.stubEnv("TWILIO_WEBHOOK_URL", "");
  vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("TWILIO_WHATSAPP_FROM", "whatsapp:+14155238886");
  Object.values(m).forEach((f) => f.mockClear());
  m.resolveWhatsAppTo.mockReturnValue(FOUNDER);
  m.decideApproval.mockResolvedValue({ ok: true, changed: true, status: "approved", message: "#7 approved." });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("whatsapp webhook", () => {
  it("valid signature + founder + 'YES 7' decides and replies with TwiML", async () => {
    const res = await POST(req({ From: FOUNDER, Body: "YES 7" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    expect(m.decideApproval).toHaveBeenCalledWith({ seq: 7, decision: "approve", via: "whatsapp" });
    expect(await res.text()).toContain("<Message>#7 approved.</Message>");
  });

  it("accepts a founder From that normalizes to the bound number", async () => {
    await POST(req({ From: "whatsapp:+1 (415) 555-1234", Body: "no 7" }));
    expect(m.decideApproval).toHaveBeenCalledWith({ seq: 7, decision: "reject", via: "whatsapp" });
  });

  it("invalid signature -> 403, no decision", async () => {
    const res = await POST(req({ From: FOUNDER, Body: "YES 7" }, { signature: "bogus" }));
    expect(res.status).toBe(403);
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("missing signature -> 403", async () => {
    expect((await POST(req({ From: FOUNDER, Body: "YES 7" }, { sign: false }))).status).toBe(403);
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("signature computed for a different URL -> 403", async () => {
    const params = { From: FOUNDER, Body: "YES 7" };
    const signature = computeTwilioSignature("https://evil.test/api/notify/whatsapp", params, TOKEN);
    expect((await POST(req(params, { signature }))).status).toBe(403);
  });

  it("body tampered after signing -> 403", async () => {
    const res = await POST(req({ From: FOUNDER, Body: "YES 99" }, { sign: { From: FOUNDER, Body: "YES 7" } }));
    expect(res.status).toBe(403);
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("valid signature but From is not the founder -> empty Response, no decision", async () => {
    const res = await POST(req({ From: "whatsapp:+14155550000", Body: "YES 7" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EMPTY);
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("no founder number configured -> empty Response, no decision", async () => {
    m.resolveWhatsAppTo.mockReturnValue(null);
    const res = await POST(req({ From: FOUNDER, Body: "YES 7" }));
    expect(await res.text()).toBe(EMPTY);
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("unparseable body from the founder -> help message, no decision", async () => {
    const res = await POST(req({ From: FOUNDER, Body: "what is this" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Reply YES &lt;n&gt; to approve");
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("honours TWILIO_WEBHOOK_URL override when signing", async () => {
    vi.stubEnv("TWILIO_WEBHOOK_URL", "https://proxy.test/hook");
    const params = { From: FOUNDER, Body: "YES 7" };
    const signature = computeTwilioSignature("https://proxy.test/hook", params, TOKEN);
    expect((await POST(req(params, { signature }))).status).toBe(200);
    expect(m.decideApproval).toHaveBeenCalled();
  });

  it("404 when Twilio env is unset", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    const res = await POST(req({ From: FOUNDER, Body: "YES 7" }, { signature: "x" }));
    expect(res.status).toBe(404);
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("handler failure returns a generic TwiML message, not a 500", async () => {
    m.decideApproval.mockRejectedValue(new Error("db down"));
    const res = await POST(req({ From: FOUNDER, Body: "YES 7" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Something went wrong");
  });
});

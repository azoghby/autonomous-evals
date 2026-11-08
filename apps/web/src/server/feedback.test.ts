import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@ae/core/db/client", () => ({ db: () => { throw new Error("db must not be touched"); }, schema: { feedbackInvites: {}, feedbackResponses: {} } }));
vi.mock("./owner-shared", () => ({ suppressEmail: vi.fn() }));
vi.mock("./rate-limit", () => ({ rateLimit: vi.fn() }));

import { optOutByToken, recordFeedbackReply, submitFeedback, type FeedbackStore } from "./feedback";
import { attribution, buildFeedbackEmail, feedbackBodyWords, FEEDBACK_EMAIL_MAX_WORDS, isPostalAddress, parseFeedback } from "./feedback-logic";

const invite = { id: "inv-1", email: "a@agentco.dev", org: "AgentCo", name: "Ada Lovelace" };

function fakeStore(over: Partial<FeedbackStore> = {}): FeedbackStore & { saved: unknown[]; suppressed: string[]; replies: unknown[] } {
  const saved: unknown[] = [], suppressed: string[] = [], replies: unknown[] = [];
  return {
    saved, suppressed, replies,
    inviteByToken: async (t) => (t === "tok" ? invite : null),
    inviteByEmail: async (e) => (e === invite.email ? invite : null),
    saveResponse: async (row) => { saved.push(row); },
    recordReply: async (id, text) => { replies.push({ id, text }); },
    suppress: async (e) => { suppressed.push(e); },
    ...over,
  };
}
const allow = async () => ({ ok: true, retryAfter: 0 });
const deps = (store: FeedbackStore, limiter = allow) => ({ store, limiter, hashIp: (ip: string) => `h:${ip}` });

describe("parseFeedback", () => {
  it("requires wouldUse to be yes, maybe or no", () => {
    expect(parseFeedback({}).kind).toBe("invalid");
    expect(parseFeedback({ wouldUse: "definitely" }).kind).toBe("invalid");
    expect(parseFeedback({ wouldUse: "maybe" }).kind).toBe("ok");
  });

  it("drops consent when there is no quote to consent to", () => {
    const r = parseFeedback({ wouldUse: "yes", quote: "  ", quoteConsent: true });
    expect(r).toMatchObject({ kind: "ok", value: { quote: null, quoteConsent: false } });
  });

  it("short-circuits a filled honeypot", () => {
    expect(parseFeedback({ wouldUse: "yes", website: "http://spam" }).kind).toBe("honeypot");
  });

  it("rejects over-long fields", () => {
    expect(parseFeedback({ wouldUse: "yes", quote: "x".repeat(601) }).kind).toBe("invalid");
  });
});

describe("submitFeedback", () => {
  it("links the response to the invite behind a valid ref", async () => {
    const store = fakeStore();
    const r = await submitFeedback({ ref: "tok", wouldUse: "yes", mustHave: "CI integration", pricePerMonth: "$50", quote: "Useful.", quoteConsent: true }, "1.2.3.4", deps(store));
    expect(r).toEqual({ ok: true });
    expect(store.saved[0]).toMatchObject({ inviteId: "inv-1", wouldUse: "yes", quote: "Useful.", quoteConsent: true, ipHash: "h:1.2.3.4" });
  });

  it("stores an unknown ref as anonymous instead of losing the answer", async () => {
    const store = fakeStore();
    await submitFeedback({ ref: "nope", wouldUse: "no" }, "ip", deps(store));
    expect(store.saved[0]).toMatchObject({ inviteId: null, wouldUse: "no" });
  });

  it("returns 400 with field errors and stores nothing", async () => {
    const store = fakeStore();
    const r = await submitFeedback({ wouldUse: "?" }, "ip", deps(store));
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(store.saved).toHaveLength(0);
  });

  it("rate-limits per hashed IP", async () => {
    const store = fakeStore();
    const limiter = vi.fn(async () => ({ ok: false, retryAfter: 42 }));
    const r = await submitFeedback({ wouldUse: "yes" }, "9.9.9.9", deps(store, limiter));
    expect(r).toEqual({ ok: false, status: 429, retryAfter: 42 });
    expect(limiter).toHaveBeenCalledWith("feedback:h:9.9.9.9", 10, 3600);
    expect(store.saved).toHaveLength(0);
  });

  it("pretends success on honeypot without touching the limiter or store", async () => {
    const store = fakeStore();
    const limiter = vi.fn(allow);
    expect(await submitFeedback({ wouldUse: "yes", website: "x" }, "ip", deps(store, limiter))).toEqual({ ok: true });
    expect(limiter).not.toHaveBeenCalled();
    expect(store.saved).toHaveLength(0);
  });
});

describe("optOutByToken / recordFeedbackReply", () => {
  it("suppresses the invite's address for a valid token only", async () => {
    const store = fakeStore();
    expect(await optOutByToken("tok", store)).toBe(true);
    expect(await optOutByToken("bad", store)).toBe(false);
    expect(await optOutByToken(null, store)).toBe(false);
    expect(store.suppressed).toEqual(["a@agentco.dev"]);
  });

  it("stores a reply from an invited builder and suppresses on STOP", async () => {
    const store = fakeStore();
    expect(await recordFeedbackReply("A@AgentCo.dev", "Looks neat, I'd pay $20", store)).toEqual({ matched: true, optedOut: false });
    expect(await recordFeedbackReply("a@agentco.dev", "unsubscribe", store)).toEqual({ matched: true, optedOut: true });
    expect(await recordFeedbackReply("stranger@x.com", "hi", store)).toEqual({ matched: false, optedOut: false });
    expect(store.replies).toHaveLength(2);
    expect(store.suppressed).toEqual(["a@agentco.dev"]);
  });
});

describe("buildFeedbackEmail", () => {
  const r = { email: "a@agentco.dev", name: "Ada Lovelace", org: "AgentCo", sourceUrl: "https://agentco.dev/contact", reason: "x ".repeat(30).trim() };

  it("stays within the word cap with a long reason and includes every required link", () => {
    const e = buildFeedbackEmail(r, { appUrl: "https://standard-evals.vercel.app/", token: "abc_DEF-1" });
    expect(feedbackBodyWords(e.text)).toBeLessThanOrEqual(FEEDBACK_EMAIL_MAX_WORDS);
    expect(e.text).toContain("Hi Ada,");
    expect(e.text).toContain("https://standard-evals.vercel.app/demo");
    expect(e.text).toContain("https://standard-evals.vercel.app/feedback?ref=abc_DEF-1");
    expect(e.text).toContain("https://standard-evals.vercel.app/api/feedback/unsubscribe?ref=abc_DEF-1");
    expect(e.headers["List-Unsubscribe"]).toBe("<https://standard-evals.vercel.app/api/feedback/unsubscribe?ref=abc_DEF-1>");
    expect(e.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("greets a team address generically and never prints a non-postal COMPANY_ADDRESS", () => {
    const e = buildFeedbackEmail({ ...r, name: null }, { appUrl: "https://x.dev", token: "t", companyAddress: "Autonomous Evals · inbox@agentmail.to" });
    expect(e.text).toContain("Hi there,");
    expect(e.text).not.toContain("Autonomous Evals ·");
    const withAddr = buildFeedbackEmail(r, { appUrl: "https://x.dev", token: "t", companyAddress: "Standard Evals, 1 Main St, SF CA 94105" });
    expect(withAddr.text).toContain("1 Main St");
    expect(isPostalAddress("[physical mailing address: set COMPANY_ADDRESS]")).toBe(false);
  });

  it("makes no customer, urgency or endorsement claims", () => {
    const e = buildFeedbackEmail(r, { appUrl: "https://x.dev", token: "t" }).text.toLowerCase();
    for (const banned of ["customers like", "limited time", "act now", "trusted by", "partnered with", "endorsed"]) expect(e).not.toContain(banned);
  });
});

describe("attribution", () => {
  it("uses only what the person typed, else a neutral label", () => {
    expect(attribution({ name: "Ada", company: "AgentCo" })).toBe("Ada, AgentCo");
    expect(attribution({ name: null, company: null })).toBe("An agent builder");
  });
});

describe("POST /api/feedback", () => {
  beforeEach(() => vi.resetModules());

  async function load(opts: { bot?: boolean; result?: unknown; throws?: boolean }) {
    vi.resetModules();
    vi.doMock("@/server/bot", () => ({ assertHuman: async () => (opts.bot ? Response.json({ error: "bot_detected" }, { status: 403 }) : null) }));
    const submit = vi.fn(async () => { if (opts.throws) throw new Error("db down"); return opts.result; });
    vi.doMock("@/server/feedback", () => ({ submitFeedback: submit }));
    vi.doMock("@/server/rate-limit", () => ({ clientIp: () => "1.1.1.1" }));
    const { POST } = await import("@/app/api/feedback/route");
    return { POST, submit };
  }
  const req = (body: string) => new Request("http://localhost/api/feedback", { method: "POST", headers: { "content-type": "application/json" }, body });

  it("blocks bots before reading the body", async () => {
    const { POST, submit } = await load({ bot: true });
    expect((await POST(req("{}"))).status).toBe(403);
    expect(submit).not.toHaveBeenCalled();
  });

  it("maps ok / 400 / 429 / 500", async () => {
    expect((await (await load({ result: { ok: true } })).POST(req('{"wouldUse":"yes"}'))).status).toBe(200);
    const bad = await (await load({ result: { ok: false, status: 400, fieldErrors: { wouldUse: ["x"] } } })).POST(req("{}"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ fieldErrors: { wouldUse: ["x"] } });
    const limited = await (await load({ result: { ok: false, status: 429, retryAfter: 7 } })).POST(req("{}"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("7");
    expect((await (await load({ throws: true })).POST(req("{}"))).status).toBe(500);
  });

  it("rejects invalid JSON and oversized bodies", async () => {
    const { POST } = await load({ result: { ok: true } });
    expect((await POST(req("not json"))).status).toBe(400);
    expect((await POST(req(JSON.stringify({ x: "y".repeat(20_000) })))).status).toBe(400);
  });
});

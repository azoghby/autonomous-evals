import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ decideApproval: vi.fn(), rateLimit: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/http", () => ({
  jsonError: (status: number, error: string, extra?: object) => Response.json({ error, ...extra }, { status }),
  readJson: async (req: Request, schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }) => {
    let raw: unknown;
    try { raw = await req.json(); } catch { return { ok: false, res: Response.json({ error: "Invalid JSON body" }, { status: 400 }) }; }
    const p = schema.safeParse(raw);
    return p.success ? { ok: true, data: p.data } : { ok: false, res: Response.json({ error: "Invalid request" }, { status: 400 }) };
  },
}));
vi.mock("@/server/rate-limit", () => ({ rateLimit: m.rateLimit, clientIp: () => "1.2.3.4" }));
vi.mock("@/server/notify/approvals", () => ({ decideApproval: m.decideApproval }));
import { signToken } from "@/server/owner-policy";
import { POST } from "./route";

const AID = "123e4567-e89b-12d3-a456-426614174000";
const future = () => Date.now() + 60_000;
const post = (body: unknown, raw = false) =>
  POST(new Request("http://localhost/api/notify/decide", { method: "POST", body: raw ? (body as string) : JSON.stringify(body) }));

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "test-session-secret");
  m.decideApproval.mockReset();
  m.decideApproval.mockResolvedValue({ ok: true, changed: true, status: "approved", message: "Approved." });
  m.rateLimit.mockReset();
  m.rateLimit.mockResolvedValue({ ok: true });
});
afterEach(() => vi.unstubAllEnvs());

describe("notify decide route", () => {
  it("valid token decides via email", async () => {
    const t = signToken("founder_decision", { aid: AID, d: "approve", exp: future() });
    const res = await post({ t });
    expect(res.status).toBe(200);
    expect(m.decideApproval).toHaveBeenCalledWith({ id: AID, decision: "approve", via: "email" });
    expect(await res.json()).toEqual({ ok: true, changed: true, status: "approved", message: "Approved." });
  });

  it("reject token maps to reject", async () => {
    await post({ t: signToken("founder_decision", { aid: AID, d: "reject", exp: future() }) });
    expect(m.decideApproval).toHaveBeenCalledWith({ id: AID, decision: "reject", via: "email" });
  });

  it("expired token -> 403", async () => {
    const t = signToken("founder_decision", { aid: AID, d: "approve", exp: Date.now() - 1000 });
    expect((await post({ t })).status).toBe(403);
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("token with the wrong purpose -> 403", async () => {
    const t = signToken("approve_all", { aid: AID, d: "approve", exp: future() });
    expect((await post({ t })).status).toBe(403);
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("token signed with a different secret -> 403", async () => {
    const t = signToken("founder_decision", { aid: AID, d: "approve", exp: future() }, { SESSION_SECRET: "other" });
    expect((await post({ t })).status).toBe(403);
  });

  it("valid signature but malformed payload (no exp / bad decision / bad id) -> 403", async () => {
    for (const p of [{ aid: AID, d: "approve" }, { aid: AID, d: "delete", exp: future() }, { aid: "nope", d: "approve", exp: future() }]) {
      expect((await post({ t: signToken("founder_decision", p) })).status).toBe(403);
    }
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("garbage token -> 403", async () => {
    expect((await post({ t: "garbage" })).status).toBe(403);
  });

  it("bad body -> 400", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ t: "" })).status).toBe(400);
    expect((await post("{nope", true)).status).toBe(400);
    expect(m.decideApproval).not.toHaveBeenCalled();
  });

  it("not_found -> 404", async () => {
    m.decideApproval.mockResolvedValue({ ok: false, changed: false, status: "not_found", message: "Approval not found." });
    const t = signToken("founder_decision", { aid: AID, d: "approve", exp: future() });
    const res = await post({ t });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Approval not found." });
  });

  it("already-decided is a 200 no-op", async () => {
    m.decideApproval.mockResolvedValue({ ok: false, changed: false, status: "approved", message: "already approved" });
    const t = signToken("founder_decision", { aid: AID, d: "approve", exp: future() });
    const res = await post({ t });
    expect(res.status).toBe(200);
    expect((await res.json()).changed).toBe(false);
  });

  it("rate limited -> 429 before touching the token", async () => {
    m.rateLimit.mockResolvedValue({ ok: false, retryAfter: 30 });
    const res = await post({ t: signToken("founder_decision", { aid: AID, d: "approve", exp: future() }) });
    expect(res.status).toBe(429);
    expect(m.decideApproval).not.toHaveBeenCalled();
  });
});

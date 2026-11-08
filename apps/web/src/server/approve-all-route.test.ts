import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./http", async () => {
  const { z } = await import("zod");
  return {
    jsonError: (status: number, error: string, extra?: object) => Response.json({ error, ...extra }, { status }),
    isUuid: (s: string) => z.uuid().safeParse(s).success,
    readJson: async (req: Request, schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }) => {
      const p = schema.safeParse(await req.json());
      return p.success ? { ok: true, data: p.data } : { ok: false, res: Response.json({ error: "bad" }, { status: 400 }) };
    },
  };
});
vi.mock("./rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true, retryAfter: 0 })), clientIp: () => "1.1.1.1" }));
vi.mock("@ae/core/db/client", () => ({ db: () => ({}), schema: {} }));
const approve = vi.fn(async (_id: string, _op: string) => ({ ok: true as const, status: "sent" as const }));
vi.mock("./outreach-approve", async (orig) => ({ ...(await orig<typeof import("./outreach-approve")>()), approveAndSendDraft: (id: string, op: string) => approve(id, op) }));

import { POST } from "@/app/api/operator/outreach/approve-all/route";
import { signToken } from "./owner-policy";
import { rateLimit } from "./rate-limit";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333";
const call = (t: string) => POST(new Request("http://x/api", { method: "POST", body: JSON.stringify({ t }) }));
const tok = (over: Record<string, unknown> = {}, purpose: "approve_all" | "unsubscribe" = "approve_all") =>
  signToken(purpose, { ids: [A, B], op: "op@example.com", exp: Date.now() + 60_000, ...over });

beforeEach(() => {
  process.env.SESSION_SECRET = "test-secret"; process.env.OPERATOR_EMAILS = "op@example.com";
  approve.mockClear(); vi.mocked(rateLimit).mockResolvedValue({ ok: true, retryAfter: 0 });
});

describe("POST /api/operator/outreach/approve-all", () => {
  it("approves exactly the ids in the token, as the token's operator", async () => {
    const res = await call(tok());
    expect(res.status).toBe(200);
    expect(approve.mock.calls).toEqual([[A, "op@example.com"], [B, "op@example.com"]]);
    expect(approve.mock.calls.some((c) => c[0] === C)).toBe(false);
    expect(await res.json()).toMatchObject({ total: 2, sent: 2, skipped: 0 });
  });
  it("rejects a token signed for another purpose", async () => {
    expect((await call(tok({}, "unsubscribe"))).status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
  });
  it("rejects an expired token", async () => {
    expect((await call(tok({ exp: Date.now() - 1 }))).status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
  });
  it("rejects a tampered token and a revoked/non-operator op", async () => {
    expect((await call(tok() + "x")).status).toBe(403);
    expect((await call(tok({ op: "evil@example.com" }))).status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
  });
  it("is rate limited", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ ok: false, retryAfter: 30 });
    expect((await call(tok())).status).toBe(429);
    expect(approve).not.toHaveBeenCalled();
  });
});

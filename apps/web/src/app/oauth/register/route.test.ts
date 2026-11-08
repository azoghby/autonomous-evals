import { describe, expect, it, vi } from "vitest";

const rateLimit = vi.hoisted(() => vi.fn());
const register = vi.hoisted(() => vi.fn());
vi.mock("@/server/rate-limit", () => ({ clientIp: () => "1.2.3.4", rateLimit }));
vi.mock("@/server/oauth/service", () => ({
  CORS_HEADERS: {}, withCors: (r: Response) => r, jsonNoStore: (b: unknown, s = 200) => Response.json(b, { status: s }),
  oauthErrorResponse: () => Response.json({ error: "x" }, { status: 400 }), originOf: () => "http://x",
  oauthService: () => ({ registerClient: register }),
}));

import { POST } from "./route";

describe("POST /oauth/register", () => {
  it("is rate limited per IP at 10/hour and registers nothing when limited", async () => {
    rateLimit.mockResolvedValueOnce({ ok: false, retryAfter: 120 });
    const res = await POST(new Request("http://x/oauth/register", { method: "POST", body: "{}" }));
    expect(res.status).toBe(429);
    expect(rateLimit).toHaveBeenCalledWith("oauth-register:1.2.3.4", 10, 3600);
    expect(register).not.toHaveBeenCalled();
  });
});

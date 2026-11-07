import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyMagicLink = vi.fn();
vi.mock("@ae/core/auth/magic-link", () => ({ verifyMagicLink: (...a: unknown[]) => verifyMagicLink(...a) }));
vi.mock("@/server/session", () => ({
  SESSION_COOKIE: "ae_session",
  sessionCookieOptions: () => ({ httpOnly: true, path: "/" }),
}));

import { GET, POST } from "./route";

const post = (body: unknown) =>
  POST(new Request("http://x/api/auth/verify", { method: "POST", body: JSON.stringify(body) }));

describe("/api/auth/verify", () => {
  beforeEach(() => vi.clearAllMocks());

  it("GET never consumes the token; it redirects to the confirm page", async () => {
    const res = await GET(new Request("http://x/api/auth/verify?token=abc&next=/jobs/1"));
    expect(verifyMagicLink).not.toHaveBeenCalled();
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/signin/confirm");
    expect(loc.searchParams.get("token")).toBe("abc");
    expect(loc.searchParams.get("next")).toBe("/jobs/1");
  });
  it("GET drops an unsafe next", async () => {
    const res = await GET(new Request("http://x/api/auth/verify?token=abc&next=//evil.com"));
    expect(new URL(res.headers.get("location")!).searchParams.get("next")).toBeNull();
  });
  it("GET without token goes to signin with an error", async () => {
    const res = await GET(new Request("http://x/api/auth/verify"));
    expect(res.headers.get("location")).toContain("/signin?auth_error=invalid");
  });
  it("POST consumes the token, sets the cookie and returns the redirect", async () => {
    verifyMagicLink.mockResolvedValue({ ok: true, sessionToken: "s", expiresAt: new Date(Date.now() + 1000) });
    const res = await post({ token: "abc", next: "/jobs/1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/jobs/1" });
    expect(res.headers.get("set-cookie")).toContain("ae_session=s");
  });
  it("POST sanitizes next", async () => {
    verifyMagicLink.mockResolvedValue({ ok: true, sessionToken: "s", expiresAt: new Date(Date.now() + 1000) });
    expect(await (await post({ token: "abc", next: "https://evil.com" })).json()).toEqual({ redirect: "/jobs" });
  });
  it("POST rejects used/expired tokens without a cookie", async () => {
    verifyMagicLink.mockResolvedValue({ ok: false, reason: "used" });
    const res = await post({ token: "abc" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "used" });
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("POST rejects a malformed body", async () => {
    expect((await post({})).status).toBe(400);
  });
});

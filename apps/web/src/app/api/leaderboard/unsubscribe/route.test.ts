import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const suppressEmail = vi.fn(async () => undefined);
vi.mock("@/server/owner-shared", () => ({ suppressEmail: (...a: unknown[]) => suppressEmail(...(a as [])) }));
import { signToken } from "@/server/owner-policy";
import { GET, POST } from "./route";

beforeEach(() => { suppressEmail.mockClear(); process.env.SESSION_SECRET = "test-secret"; });
const url = (t: string) => `https://x.test/api/leaderboard/unsubscribe?t=${encodeURIComponent(t)}`;

describe("unsubscribe route", () => {
  it("GET with valid token shows a confirm form and does NOT suppress (link scanners prefetch GETs)", async () => {
    const res = await GET(new Request(url(signToken("unsubscribe", { e: "o@x.co" }))));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('method="post"');
    expect(suppressEmail).not.toHaveBeenCalled();
  });
  it("POST from the confirm form suppresses and redirects 303", async () => {
    const res = await POST(new Request(url(signToken("unsubscribe", { e: "o@x.co" })), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/leaderboard/unsubscribed");
    expect(suppressEmail).toHaveBeenCalledWith("o@x.co", "owner_unsubscribe");
  });
  it("RFC 8058 one-click POST returns 200", async () => {
    const res = await POST(new Request(url(signToken("unsubscribe", { e: "o@x.co" })), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }));
    expect(res.status).toBe(200);
  });
  it("POST one-click returns 200", async () => {
    const res = await POST(new Request(url(signToken("unsubscribe", { e: "o@x.co" })), { method: "POST" }));
    expect(res.status).toBe(200);
    expect(suppressEmail).toHaveBeenCalled();
  });
  it("rejects bad, wrong-purpose and missing tokens with 400", async () => {
    for (const t of ["garbage", signToken("owner_results", { e: "o@x.co" })]) {
      expect((await GET(new Request(url(t)))).status).toBe(400);
    }
    expect((await POST(new Request("https://x.test/api/leaderboard/unsubscribe", { method: "POST" }))).status).toBe(400);
    expect(suppressEmail).not.toHaveBeenCalled();
  });
});

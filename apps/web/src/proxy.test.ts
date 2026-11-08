import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const rateLimit = vi.hoisted(() => vi.fn());
vi.mock("@/server/rate-limit", () => ({ clientIp: () => "9.9.9.9", rateLimit }));

import { config, proxy } from "./proxy";

describe("share-page proxy", () => {
  it("returns a real 429 with Retry-After when throttled", async () => {
    rateLimit.mockResolvedValueOnce({ ok: false, retryAfter: 30 });
    const res = await proxy(new NextRequest("http://x/r/tok"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(rateLimit).toHaveBeenCalledWith("share-page:9.9.9.9", 60, 60);
  });

  it("passes through when allowed, and only matches the share page itself", async () => {
    rateLimit.mockResolvedValueOnce({ ok: true, retryAfter: 0 });
    const res = await proxy(new NextRequest("http://x/r/tok"));
    expect(res.status).toBe(200);
    expect(config.matcher).toEqual(["/r/:token"]);
  });
});

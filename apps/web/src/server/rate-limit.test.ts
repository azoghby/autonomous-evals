import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn();
vi.mock("@ae/core/db/client", () => ({ db: () => ({ execute }) }));

import { rateLimit, clientIp } from "./rate-limit";

describe("rateLimit", () => {
  beforeEach(() => { execute.mockReset(); vi.spyOn(console, "error").mockImplementation(() => {}); });

  it("allows requests up to the limit", async () => {
    execute.mockResolvedValue({ rows: [{ count: 5, retry_after: 300 }] });
    expect(await rateLimit("k", 5, 600)).toEqual({ ok: true, retryAfter: 0 });
  });

  it("blocks past the limit and reports retryAfter", async () => {
    execute.mockResolvedValue({ rows: [{ count: "6", retry_after: 123 }] });
    expect(await rateLimit("k", 5, 600)).toEqual({ ok: false, retryAfter: 123 });
  });

  it("never reports a zero retryAfter when blocked", async () => {
    execute.mockResolvedValue({ rows: [{ count: 9, retry_after: 0 }] });
    expect((await rateLimit("k", 5, 600)).retryAfter).toBe(1);
  });

  it("fails open when the database errors", async () => {
    execute.mockRejectedValue(new Error("db down"));
    expect(await rateLimit("k", 5, 600)).toEqual({ ok: true, retryAfter: 0 });
  });
});

describe("clientIp", () => {
  it("uses the first x-forwarded-for entry", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } }))).toBe("1.2.3.4");
  });
  it("falls back to unknown", () => {
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});

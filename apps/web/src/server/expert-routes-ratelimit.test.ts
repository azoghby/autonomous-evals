import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rateLimit: vi.fn(), bookSlot: vi.fn(), cancelBooking: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/rate-limit", () => ({ rateLimit: h.rateLimit }));
vi.mock("@/server/expert-calls", () => ({ bookSlot: h.bookSlot, cancelBooking: h.cancelBooking }));

import { POST as book } from "../app/api/expert/r/[token]/book/route";
import { POST as cancel } from "../app/api/expert/r/[token]/cancel-booking/route";
import { hashToken } from "@ae/core/auth/tokens";

const ctx = { params: Promise.resolve({ token: "tok123" }) };
const bookReq = () => new Request("http://x/api", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ slotId: "11111111-1111-4111-8111-111111111111", recordingConsent: false }),
});

beforeEach(() => { for (const f of Object.values(h)) f.mockReset(); });

describe("expert booking routes are rate limited per token hash", () => {
  it("book: 429 and no booking when over the limit", async () => {
    h.rateLimit.mockResolvedValue({ ok: false, retryAfter: 30 });
    const res = await book(bookReq(), ctx);
    expect(res.status).toBe(429);
    expect(h.rateLimit).toHaveBeenCalledWith(`expert-book:${hashToken("tok123")}`, 10, 600);
    expect(h.bookSlot).not.toHaveBeenCalled();
  });
  it("cancel-booking: 429 and no cancellation when over the limit", async () => {
    h.rateLimit.mockResolvedValue({ ok: false, retryAfter: 30 });
    const res = await cancel(new Request("http://x/api", { method: "POST" }), ctx);
    expect(res.status).toBe(429);
    expect(h.rateLimit).toHaveBeenCalledWith(`expert-cancel-booking:${hashToken("tok123")}`, 10, 600);
    expect(h.cancelBooking).not.toHaveBeenCalled();
  });
  it("proceeds when under the limit", async () => {
    h.rateLimit.mockResolvedValue({ ok: true, retryAfter: 0 });
    h.cancelBooking.mockResolvedValue({ ok: true });
    expect((await cancel(new Request("http://x/api", { method: "POST" }), ctx)).status).toBe(200);
  });
});

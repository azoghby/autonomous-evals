import { describe, expect, it } from "vitest";
import { maskPhone, noopMessage, parseDecisionToken, phoneSummary, redactEmails, transition } from "./approvals-logic";

const now = new Date("2026-11-07T12:00:00Z");
const later = new Date("2026-11-08T12:00:00Z");
const earlier = new Date("2026-11-06T12:00:00Z");

describe("approval state machine", () => {
  it("pending -> approved / rejected", () => {
    expect(transition({ status: "pending", expiresAt: later }, "approve", now)).toEqual({ kind: "apply", to: "approved" });
    expect(transition({ status: "pending", expiresAt: later }, "reject", now)).toEqual({ kind: "apply", to: "rejected" });
    expect(transition({ status: "pending", expiresAt: null }, "approve", now)).toEqual({ kind: "apply", to: "approved" });
  });

  it("pending past expiry -> expire, never applies", () => {
    expect(transition({ status: "pending", expiresAt: earlier }, "approve", now)).toEqual({ kind: "expire" });
    expect(transition({ status: "pending", expiresAt: now }, "reject", now)).toEqual({ kind: "expire" });
  });

  it("decided items are no-ops (double tap, replayed webhook, reused link)", () => {
    for (const d of ["approve", "reject"] as const) {
      expect(transition({ status: "approved", expiresAt: later }, d, now)).toEqual({ kind: "noop", reason: "already_approved" });
      expect(transition({ status: "rejected", expiresAt: later }, d, now)).toEqual({ kind: "noop", reason: "already_rejected" });
      expect(transition({ status: "expired", expiresAt: earlier }, d, now)).toEqual({ kind: "noop", reason: "expired" });
      expect(transition({ status: "fyi", expiresAt: null }, d, now)).toEqual({ kind: "noop", reason: "fyi" });
      expect(transition({ status: "weird", expiresAt: null }, d, now)).toEqual({ kind: "noop", reason: "unknown_status" });
    }
  });

  it("no-op messages name the item", () => {
    expect(noopMessage("already_approved", 12)).toContain("#12 was already approved");
    expect(noopMessage("expire", 3)).toContain("#3 has expired");
    expect(noopMessage("fyi", 4)).toContain("FYI");
  });
});

describe("redaction", () => {
  it("redacts email local parts but keeps the domain", () => {
    expect(redactEmails("Draft to jane.doe@acme.io and bob@x.co.uk")).toBe("Draft to j***@acme.io and b***@x.co.uk");
  });
  it("phoneSummary collapses whitespace, redacts and truncates", () => {
    expect(phoneSummary("a\n\n b  c@d.com")).toBe("a b c***@d.com");
    const long = phoneSummary("x".repeat(600));
    expect(long.length).toBe(500);
    expect(long.endsWith("...")).toBe(true);
  });
  it("maskPhone keeps last 4 digits", () => {
    expect(maskPhone("whatsapp:+14155551234")).toBe("whatsapp:+1••••••1234");
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone("12")).toBe("•••");
  });
});

describe("parseDecisionToken", () => {
  const aid = "0b6c2f4e-8a1d-4c3b-9f2e-1a2b3c4d5e6f";
  it("accepts a well-formed unexpired payload", () => {
    expect(parseDecisionToken({ aid, d: "approve", exp: now.getTime() + 1000 }, now.getTime())).toEqual({ aid, d: "approve", exp: now.getTime() + 1000 });
  });
  it("rejects expired, malformed or missing payloads", () => {
    expect(parseDecisionToken(null)).toBeNull();
    expect(parseDecisionToken({ aid, d: "approve", exp: now.getTime() - 1 }, now.getTime())).toBeNull();
    expect(parseDecisionToken({ aid, d: "delete", exp: now.getTime() + 1000 }, now.getTime())).toBeNull();
    expect(parseDecisionToken({ aid: "x' or 1=1", d: "approve", exp: now.getTime() + 1000 }, now.getTime())).toBeNull();
    expect(parseDecisionToken({ aid, d: "approve" }, now.getTime())).toBeNull();
  });
});

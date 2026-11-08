import { describe, expect, it } from "vitest";
import { checkMagicLink, hashToken, isOperator, newToken, normalizeEmail, safeNextPath } from "./tokens";

describe("tokens", () => {
  it("generates unique 32-byte tokens and hashes deterministically (sha256 hex)", () => {
    const t = newToken();
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    expect(newToken()).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(t);
  });
  it("magic link validity: ok, expired, used", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const future = new Date(now.getTime() + 60_000), past = new Date(now.getTime() - 1);
    expect(checkMagicLink({ expiresAt: future, usedAt: null }, now)).toBe("ok");
    expect(checkMagicLink({ expiresAt: past, usedAt: null }, now)).toBe("expired");
    expect(checkMagicLink({ expiresAt: now, usedAt: null }, now)).toBe("expired");
    expect(checkMagicLink({ expiresAt: future, usedAt: now }, now)).toBe("used");
  });
  it("normalizes email and matches the operator allowlist case-insensitively", () => {
    expect(normalizeEmail("  Foo@Bar.COM ")).toBe("foo@bar.com");
    expect(isOperator("A@x.com", "a@x.com, b@y.com")).toBe(true);
    expect(isOperator("c@x.com", "a@x.com")).toBe(false);
    expect(isOperator("a@x.com", "")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it.each([
    ["/jobs/123", "/jobs/123"],
    ["/jobs?x=1#h", "/jobs?x=1#h"],
    [null, "/jobs"],
    ["", "/jobs"],
    ["https://evil.com", "/jobs"],
    ["//evil.com", "/jobs"],
    ["/\\evil.com", "/jobs"],
    ["\\\\evil.com", "/jobs"],
    ["javascript:alert(1)", "/jobs"],
    ["/%0d%0a", "/%0d%0a"],
    ["/a\nb", "/jobs"],
    ["evil.com", "/jobs"],
  ])("%s -> %s", (input, expected) => {
    expect(safeNextPath(input as string | null)).toBe(expected);
  });
});

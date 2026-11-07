import { describe, expect, it } from "vitest";
import { hashToken } from "@ae/core/auth/tokens";
import { generateKeyString, keyDisplayPrefix, parseKeyFormat } from "./api-key-format";

describe("api key format", () => {
  it("generates live and test keys that parse", () => {
    expect(generateKeyString(true).startsWith("ae_live_")).toBe(true);
    expect(generateKeyString(false).startsWith("ae_test_")).toBe(true);
    expect(parseKeyFormat(generateKeyString(true))).toBe("live");
    expect(parseKeyFormat(generateKeyString(false))).toBe("test");
  });
  it("uses the first 12 chars as display prefix", () => {
    const k = generateKeyString(true);
    expect(keyDisplayPrefix(k)).toBe(k.slice(0, 12));
    expect(keyDisplayPrefix(k)).toHaveLength(12);
  });
  it("generates unique keys", () => {
    expect(new Set(Array.from({ length: 200 }, () => generateKeyString(true))).size).toBe(200);
  });
  it("hash is 64 hex and differs from the key", () => {
    const k = generateKeyString(true);
    const h = hashToken(k);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(k);
  });
  it("rejects bad formats", () => {
    for (const bad of [undefined, null, "", "ae_live_", "ae_live_short", "sk_live_" + "a".repeat(43), "ae_prod_" + "a".repeat(43), "ae_live_" + "a".repeat(42) + "!", " ae_live_" + "a".repeat(43)]) {
      expect(parseKeyFormat(bad as string | undefined)).toBeNull();
    }
  });
});

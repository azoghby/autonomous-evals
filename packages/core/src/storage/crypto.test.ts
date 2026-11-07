import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decrypt, decryptJson, encrypt, encryptJson } from "./crypto";

const key = randomBytes(32);

describe("crypto", () => {
  it("round-trips and uses the v1 format with fresh IVs", () => {
    const a = encrypt("sk-secret", key), b = encrypt("sk-secret", key);
    expect(a.split(":")).toHaveLength(4);
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe("sk-secret");
  });
  it("round-trips JSON", () => {
    expect(decryptJson(encryptJson({ endpoint: "k" }, key), key)).toEqual({ endpoint: "k" });
  });
  it("detects tampering with ciphertext, tag, and wrong key", () => {
    const [v, iv, tag, ct] = encrypt("hello", key).split(":");
    const flip = (s: string) => { const b = Buffer.from(s, "base64"); b[0] = b[0]! ^ 1; return b.toString("base64"); };
    expect(() => decrypt([v, iv, tag, flip(ct!)].join(":"), key)).toThrow();
    expect(() => decrypt([v, iv, flip(tag!), ct].join(":"), key)).toThrow();
    expect(() => decrypt(encrypt("hello", key), randomBytes(32))).toThrow();
  });
  it("rejects unknown versions and malformed input", () => {
    expect(() => decrypt("v2:a:b:c", key)).toThrow();
    expect(() => decrypt("garbage", key)).toThrow();
  });
});

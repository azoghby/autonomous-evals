import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

function keyFromEnv(): Buffer {
  const b64 = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!b64) throw new Error("CREDENTIALS_ENCRYPTION_KEY is not set");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("CREDENTIALS_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

/** AES-256-GCM. Output format: "v1:<iv>:<tag>:<ciphertext>" (each base64). */
export function encrypt(plaintext: string, key: Buffer = keyFromEnv()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decrypt(payload: string, key: Buffer = keyFromEnv()): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("Unsupported ciphertext format");
  const [, iv, tag, ct] = parts.map((p, i) => (i === 0 ? p : Buffer.from(p, "base64"))) as [string, Buffer, Buffer, Buffer];
  if (iv.length !== 12 || tag.length !== 16) throw new Error("Malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export const encryptJson = (value: unknown, key?: Buffer) => encrypt(JSON.stringify(value), key);
export const decryptJson = <T>(payload: string, key?: Buffer): T => JSON.parse(decrypt(payload, key)) as T;

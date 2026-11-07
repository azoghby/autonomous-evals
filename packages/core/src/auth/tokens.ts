import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export type LinkCheck = "ok" | "used" | "expired";
/** Pure validity check for a magic-link row. */
export function checkMagicLink(row: { expiresAt: Date; usedAt: Date | null }, now = new Date()): LinkCheck {
  if (row.usedAt) return "used";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "ok";
}

/** Open-redirect guard: only same-origin relative paths. */
export function safeNextPath(next: string | null | undefined, fallback = "/jobs"): string {
  if (!next) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f\\]/.test(next)) return fallback;
  try {
    const u = new URL(next, "http://localhost");
    if (u.origin !== "http://localhost") return fallback;
  } catch { return fallback; }
  return next;
}

export function operatorEmails(env = process.env.OPERATOR_EMAILS): Set<string> {
  return new Set((env ?? "").split(",").map(normalizeEmail).filter(Boolean));
}
export function isOperator(email: string, env?: string): boolean {
  return operatorEmails(env ?? process.env.OPERATOR_EMAILS).has(normalizeEmail(email));
}

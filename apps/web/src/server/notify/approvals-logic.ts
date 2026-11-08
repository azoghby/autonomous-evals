/** Pure founder-approval state machine + helpers. No I/O, fully unit-tested (approvals-logic.test.ts). */
import type { ApprovalStatus, Decision } from "./types";

export const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Email one-click links expire after 24h (the approval itself may live longer; open the console then). */
export const EMAIL_LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_TITLE_CHARS = 120;
export const MAX_SUMMARY_CHARS = 500;

export interface ApprovalState { status: ApprovalStatus | string; expiresAt: Date | null }

export type Transition =
  | { kind: "apply"; to: "approved" | "rejected" }
  | { kind: "expire" }
  | { kind: "noop"; reason: "already_approved" | "already_rejected" | "expired" | "fyi" | "unknown_status" };

/**
 * The only legal transitions: pending -> approved | rejected (once), pending -> expired (past expiresAt).
 * Everything else is a no-op, which is what makes a double tap / replayed webhook / reused link harmless.
 */
export function transition(state: ApprovalState, decision: Decision, now: Date): Transition {
  switch (state.status) {
    case "pending":
      if (state.expiresAt && state.expiresAt.getTime() <= now.getTime()) return { kind: "expire" };
      return { kind: "apply", to: decision === "approve" ? "approved" : "rejected" };
    case "approved": return { kind: "noop", reason: "already_approved" };
    case "rejected": return { kind: "noop", reason: "already_rejected" };
    case "expired": return { kind: "noop", reason: "expired" };
    case "fyi": return { kind: "noop", reason: "fyi" };
    default: return { kind: "noop", reason: "unknown_status" };
  }
}

export function noopMessage(reason: Extract<Transition, { kind: "noop" }>["reason"] | "expire", seq: number): string {
  switch (reason) {
    case "already_approved": return `#${seq} was already approved. Nothing changed.`;
    case "already_rejected": return `#${seq} was already rejected. Nothing changed.`;
    case "expired": case "expire": return `#${seq} has expired. Open the operator console to handle it.`;
    case "fyi": return `#${seq} is FYI only; there is nothing to approve.`;
    default: return `#${seq} cannot be decided.`;
  }
}

const EMAIL_RE = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

/** Redacts email addresses to "j***@example.com": the company/domain is useful, the person's address is not. */
export function redactEmails(s: string): string {
  return s.replace(EMAIL_RE, (_m, first: string, domain: string) => `${first}***@${domain}`);
}

/** Phone numbers in summaries: keep the last 4 digits only. */
export function maskPhone(s: string | null | undefined): string | null {
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 6) return "•••";
  return `${s.startsWith("whatsapp:") ? "whatsapp:" : ""}+${digits.slice(0, 1)}${"•".repeat(Math.max(0, digits.length - 5))}${digits.slice(-4)}`;
}

/** Normalizes a free-text summary for phones: collapse whitespace, redact emails, truncate. Secret redaction happens upstream (redactAlertText). */
export function phoneSummary(s: string, max = MAX_SUMMARY_CHARS): string {
  const out = redactEmails(s).replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 3)}...` : out;
}

export interface DecisionTokenPayload { aid: string; d: Decision; exp: number; [k: string]: unknown }

/** Validates a verified (signature-checked) decision token's payload shape and expiry. */
export function parseDecisionToken(p: Record<string, unknown> | null, now = Date.now()): DecisionTokenPayload | null {
  if (!p) return null;
  const { aid, d, exp } = p;
  if (typeof aid !== "string" || !/^[0-9a-f-]{36}$/i.test(aid)) return null;
  if (d !== "approve" && d !== "reject") return null;
  if (typeof exp !== "number" || exp <= now) return null;
  return { aid, d, exp };
}

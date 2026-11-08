/** Shared shapes for founder notification channels (Telegram, WhatsApp via Twilio, email). Pure: no I/O. */

export type Decision = "approve" | "reject";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "fyi";
export type DecidedVia = "telegram" | "whatsapp" | "email" | "console";

/** What a channel needs to render one approval request (or FYI) on the founder's phone. */
export interface ApprovalMessage {
  /** Short integer id shown to the founder ("YES 12"). */
  seq: number;
  kind: string;
  title: string;
  /** Already redacted, phone-sized (<= ~500 chars). */
  summary: string;
  /** Absolute URL to view details (operator console). */
  viewUrl: string;
  /** null = FYI only (no decision buttons, only View). */
  actions: { approveLabel: string; rejectLabel: string | null } | null;
}

export interface FetchResponseLike { ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }
export type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponseLike>;

export type Env = Record<string, string | undefined>;

/** Max chars for any single outbound message body (Telegram limit is 4096; WhatsApp 1600). */
export const MAX_MESSAGE_CHARS = 1500;

export function truncate(s: string, max = MAX_MESSAGE_CHARS): string {
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

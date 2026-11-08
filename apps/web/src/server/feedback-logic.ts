/**
 * Pure helpers for the user-feedback campaign: /feedback input validation and the invite email.
 * No DB or network here, so the outreach script and tests can use them directly.
 */
import { z } from "zod";

export const WOULD_USE = ["yes", "maybe", "no"] as const;
export type WouldUse = (typeof WOULD_USE)[number];

/** Hard cap for the whole campaign (one email per recipient, no follow-ups). */
export const FEEDBACK_SEND_CAP = 25;
export const FEEDBACK_RATE_LIMIT = 10;
export const FEEDBACK_RATE_WINDOW_SECONDS = 3600;
export const FEEDBACK_EMAIL_MAX_WORDS = 120;
export const FOUNDER_REPLY_TO = "ronitkat08@gmail.com";

/** Optional free text: trimmed, capped, empty -> null. */
const optText = (max: number) =>
  z.string().trim().max(max).optional().nullable().transform((v) => (v ? v : null));

export const feedbackInput = z.object({
  ref: z.string().trim().max(128).optional().nullable().transform((v) => (v ? v : null)),
  wouldUse: z.enum(WOULD_USE),
  mustHave: optText(2000),
  pricePerMonth: optText(120),
  quote: optText(600),
  quoteConsent: z.boolean().optional().default(false),
  name: optText(200),
  company: optText(200),
  /** Honeypot: real users never see or fill this. */
  website: z.string().max(500).optional(),
});
export type FeedbackInput = z.output<typeof feedbackInput>;

export type ParsedFeedback =
  | { kind: "invalid"; fieldErrors: Record<string, string[]> }
  | { kind: "honeypot" }
  | { kind: "ok"; value: Omit<FeedbackInput, "website"> };

/** Validation + honeypot. Consent only sticks when there is a quote to consent to. */
export function parseFeedback(raw: unknown): ParsedFeedback {
  const website = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).website : undefined;
  if (typeof website === "string" && website.trim() !== "") return { kind: "honeypot" };
  const parsed = feedbackInput.safeParse(raw);
  if (!parsed.success) return { kind: "invalid", fieldErrors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]> };
  const { website: _w, ...value } = parsed.data;
  return { kind: "ok", value: { ...value, quoteConsent: value.quoteConsent && !!value.quote } };
}

/** A public quote card: only what the person typed and explicitly consented to show. */
export interface PublicQuote { id: string; quote: string; name: string | null; company: string | null }

export const attribution = (q: Pick<PublicQuote, "name" | "company">): string =>
  [q.name, q.company].filter(Boolean).join(", ") || "An agent builder";

/* ---------------- invite email ---------------- */

export interface FeedbackRecipient {
  email: string;
  /** Person's name when the address is personal; null for a team/contact address. */
  name: string | null;
  org: string;
  /** One specific sentence on why this is relevant to them. */
  reason: string;
  /** Public page where this address is published. */
  sourceUrl: string;
}

export interface FeedbackEmailLinks { appUrl: string; token: string; companyAddress?: string | null }
export interface FeedbackEmail { subject: string; text: string; headers: Record<string, string>; feedbackUrl: string; optOutUrl: string }

export const FEEDBACK_SUBJECT = "Quick opinion on an agent-eval tool we built overnight?";

const firstName = (name: string | null): string => (name?.trim().split(/\s+/)[0] ?? "") || "there";

/** A postal address has a digit (street number / ZIP). Anything else (e.g. a bare email) is not shown as one. */
export const isPostalAddress = (s: string | null | undefined): s is string => !!s && /\d/.test(s) && !s.includes("[");

export const feedbackUrl = (appUrl: string, token: string): string => `${appUrl}/feedback?ref=${encodeURIComponent(token)}`;
export const feedbackOptOutUrl = (appUrl: string, token: string): string => `${appUrl}/api/feedback/unsubscribe?ref=${encodeURIComponent(token)}`;

export const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** Body (above the opt-out footer) and footer, kept apart so the word cap applies to what we wrote. */
export function buildFeedbackEmail(r: FeedbackRecipient, l: FeedbackEmailLinks): FeedbackEmail {
  const app = l.appUrl.replace(/\/$/, "");
  const fUrl = feedbackUrl(app, l.token);
  const optOut = feedbackOptOutUrl(app, l.token);
  const body = [
    `Hi ${firstName(r.name)},`,
    "",
    "I'm Ronit. On Nov 8, at a hackathon, a team of AI agents and I built Standard Evals: it tests AI agents against a simulated customer in a sandbox and grades what they actually did, not what they said.",
    "",
    r.reason.trim(),
    "",
    `Site: ${app}`,
    `Demo: ${app}/demo`,
    "",
    "Honest question: would you actually use this? What would make it a must-have, and what would you pay per month? A one-line reply is plenty, or use this form:",
    fUrl,
    "",
    "Thanks,",
    "Ronit (our agent sent this for me; replies reach me directly)",
  ].join("\n");
  const footer = [
    "--",
    `Not interested? One click and we won't email you again: ${optOut}`,
    ...(isPostalAddress(l.companyAddress) ? [l.companyAddress.trim()] : []),
  ].join("\n");
  return {
    subject: FEEDBACK_SUBJECT,
    text: `${body}\n\n${footer}`,
    headers: { "List-Unsubscribe": `<${optOut}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    feedbackUrl: fUrl,
    optOutUrl: optOut,
  };
}

/** Body word count (everything above the "--" footer). */
export const feedbackBodyWords = (text: string): number => wordCount(text.split("\n--\n")[0] ?? text);

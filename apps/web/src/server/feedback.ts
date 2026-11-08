import "server-only";
/**
 * User-feedback campaign: /feedback submissions, the operator responses view, the public "What builders say"
 * quotes, invite opt-out, and inbound-reply bookkeeping. DB access sits behind FeedbackStore so tests inject it.
 */
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { isOptOut } from "@ae/core/company/outreach";
import { FEEDBACK_RATE_LIMIT, FEEDBACK_RATE_WINDOW_SECONDS, parseFeedback, type FeedbackInput, type PublicQuote } from "./feedback-logic";
import { ipHash } from "./owner-policy";
import { rateLimit, type RateLimitResult } from "./rate-limit";
import { suppressEmail } from "./owner-shared";

export interface InviteRef { id: string; email: string; org: string; name: string | null }

export interface FeedbackRow {
  id: string; createdAt: string; wouldUse: string; mustHave: string | null; pricePerMonth: string | null;
  quote: string | null; quoteConsent: boolean; name: string | null; company: string | null;
  invite: { org: string; name: string | null; email: string } | null;
}

export interface InviteRow {
  id: string; org: string; name: string | null; email: string; status: string; sentAt: string | null;
  repliedAt: string | null; replyText: string | null; sourceUrl: string;
}

export interface FeedbackStore {
  inviteByToken(token: string): Promise<InviteRef | null>;
  inviteByEmail(email: string): Promise<InviteRef | null>;
  /** Insert, or update the invite's existing response (one per invite). */
  saveResponse(row: Omit<FeedbackInput, "ref" | "website"> & { inviteId: string | null; ipHash: string }): Promise<void>;
  recordReply(inviteId: string, text: string, at: Date): Promise<void>;
  suppress(email: string): Promise<void>;
}

export type SubmitFeedbackResult =
  | { ok: true }
  | { ok: false; status: 400; fieldErrors: Record<string, string[]> }
  | { ok: false; status: 429; retryAfter: number };

export interface SubmitDeps {
  store?: FeedbackStore;
  limiter?: (key: string, limit: number, windowSec: number) => Promise<RateLimitResult>;
  hashIp?: (ip: string) => string;
}

/** Validates, rate-limits per IP, links to the invite (unknown ref => anonymous) and stores. */
export async function submitFeedback(raw: unknown, ip: string, deps: SubmitDeps = {}): Promise<SubmitFeedbackResult> {
  const parsed = parseFeedback(raw);
  if (parsed.kind === "honeypot") return { ok: true };
  if (parsed.kind === "invalid") return { ok: false, status: 400, fieldErrors: parsed.fieldErrors };
  const hash = (deps.hashIp ?? ipHash)(ip);
  const rl = await (deps.limiter ?? rateLimit)(`feedback:${hash}`, FEEDBACK_RATE_LIMIT, FEEDBACK_RATE_WINDOW_SECONDS);
  if (!rl.ok) return { ok: false, status: 429, retryAfter: rl.retryAfter };
  const store = deps.store ?? drizzleFeedbackStore();
  const { ref, ...v } = parsed.value;
  const invite = ref ? await store.inviteByToken(ref) : null;
  await store.saveResponse({ ...v, inviteId: invite?.id ?? null, ipHash: hash });
  return { ok: true };
}

/** One-click opt-out from the invite footer: adds the invite's address to the shared suppression list. */
export async function optOutByToken(token: string | null, store: FeedbackStore = drizzleFeedbackStore()): Promise<boolean> {
  if (!token || token.length > 128) return false;
  const invite = await store.inviteByToken(token);
  if (!invite) return false;
  await store.suppress(invite.email);
  return true;
}

/** Inbound email from an invited builder: store the reply for the founder; an opt-out reply suppresses them. */
export async function recordFeedbackReply(
  fromEmail: string, text: string, store: FeedbackStore = drizzleFeedbackStore(), now = new Date(),
): Promise<{ matched: boolean; optedOut: boolean }> {
  const invite = await store.inviteByEmail(fromEmail.trim().toLowerCase());
  if (!invite) return { matched: false, optedOut: false };
  await store.recordReply(invite.id, text.slice(0, 10_000), now);
  const optedOut = isOptOut(text);
  if (optedOut) await store.suppress(invite.email);
  return { matched: true, optedOut };
}

/* ---------------- drizzle ---------------- */

const I = schema.feedbackInvites;
const R = schema.feedbackResponses;
const inviteCols = { id: I.id, email: I.email, org: I.org, name: I.name };

export function drizzleFeedbackStore(): FeedbackStore {
  return {
    async inviteByToken(token) {
      const [r] = await db().select(inviteCols).from(I).where(eq(I.token, token)).limit(1);
      return r ?? null;
    },
    async inviteByEmail(email) {
      const [r] = await db().select(inviteCols).from(I).where(sql`lower(${I.email}) = ${email}`).limit(1);
      return r ?? null;
    },
    async saveResponse(row) {
      const values = { ...row, updatedAt: new Date() };
      if (!row.inviteId) { await db().insert(R).values(values); return; }
      const { inviteId: _id, ...set } = values;
      await db().insert(R).values(values).onConflictDoUpdate({ target: R.inviteId, set });
    },
    async recordReply(inviteId, text, at) {
      await db().update(I).set({ status: "replied", replyText: text, repliedAt: at }).where(eq(I.id, inviteId));
    },
    suppress: (email) => suppressEmail(email, "feedback_opt_out"),
  };
}

/** Operator view: latest responses with their invite (caller enforces operator auth). */
export async function listFeedbackResponses(limit = 100): Promise<FeedbackRow[]> {
  const rows = await db().select({ r: R, org: I.org, inviteName: I.name, email: I.email })
    .from(R).leftJoin(I, eq(R.inviteId, I.id)).orderBy(desc(R.createdAt)).limit(limit);
  return rows.map(({ r, org, inviteName, email }) => ({
    id: r.id, createdAt: new Date(r.createdAt).toISOString(), wouldUse: r.wouldUse, mustHave: r.mustHave,
    pricePerMonth: r.pricePerMonth, quote: r.quote, quoteConsent: r.quoteConsent, name: r.name, company: r.company,
    invite: org && email ? { org, name: inviteName, email } : null,
  }));
}

/** Operator view: every invite with send / reply status (email replies land here via the AgentMail webhook). */
export async function listFeedbackInvites(limit = 100): Promise<InviteRow[]> {
  const rows = await db().select().from(I).orderBy(desc(I.createdAt)).limit(limit);
  return rows.map((r) => ({
    id: r.id, org: r.org, name: r.name, email: r.email, status: r.status, sourceUrl: r.sourceUrl,
    sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null,
    repliedAt: r.repliedAt ? new Date(r.repliedAt).toISOString() : null, replyText: r.replyText,
  }));
}

/** Public quotes: consented, non-empty, from a real invite only (anonymous submissions are never shown). */
export async function listPublicQuotes(limit = 6): Promise<PublicQuote[]> {
  const rows = await db().select({ id: R.id, quote: R.quote, name: R.name, company: R.company }).from(R)
    .innerJoin(I, eq(R.inviteId, I.id))
    .where(and(eq(R.quoteConsent, true), isNotNull(R.quote), sql`length(trim(${R.quote})) > 0`))
    .orderBy(desc(R.updatedAt)).limit(limit);
  return rows.filter((r): r is typeof r & { quote: string } => !!r.quote).map((r) => ({ id: r.id, quote: r.quote, name: r.name, company: r.company }));
}

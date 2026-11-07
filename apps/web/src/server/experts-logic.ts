/**
 * Pure helpers for the Expert Network (no DB, no server-only) so guardrails are unit-testable.
 * See docs/EXPERT_NETWORK.md.
 */
import { HONORARIUM_CENTS, type ExpertMode, type ExpertSource } from "@ae/core/contracts/experts";

export const COLD_CONTACTS_PER_DAY = 10;
export const ENGAGEMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** Start of the current UTC day; the rate-limit window. */
export function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export type RateLimit = { allowed: true; remaining: number } | { allowed: false; remaining: 0 };
/** Cold-contact rate limit: `approvedToday` counts approved/sent drafts to agent_researched experts. */
export function coldContactRateLimit(approvedToday: number, limit = COLD_CONTACTS_PER_DAY): RateLimit {
  const remaining = Math.max(0, limit - approvedToday);
  return remaining > 0 ? { allowed: true, remaining } : { allowed: false, remaining: 0 };
}

export type TokenCheck = "ok" | "not_found" | "expired" | "used" | "cancelled";
/** Validity of an engagement token row. An answered/paid engagement is "used". */
export function checkEngagementToken(
  row: { status: string; expiresAt: Date } | null | undefined, now = new Date(),
): TokenCheck {
  if (!row) return "not_found";
  if (row.status === "cancelled") return "cancelled";
  if (row.status === "answered" || row.status === "paid") return "used";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "ok";
}

export type InviteBlock =
  | "expert_opted_out" | "email_suppressed" | "over_budget" | "request_closed" | "already_invited";
/** Policy check before an invite is created. Returns the first reason it is blocked, or null. */
export function inviteBlockReason(input: {
  expertStatus: string; suppressed: boolean; requestStatus: string;
  alreadyInvited: boolean; committedCents: number; honorariumCents: number; maxBudgetCents: number;
}): InviteBlock | null {
  if (input.suppressed) return "email_suppressed";
  if (input.expertStatus === "opted_out") return "expert_opted_out";
  if (input.requestStatus === "closed") return "request_closed";
  if (input.alreadyInvited) return "already_invited";
  if (input.committedCents + input.honorariumCents > input.maxBudgetCents) return "over_budget";
  return null;
}

export const INVITE_BLOCK_MESSAGE: Record<InviteBlock, string> = {
  expert_opted_out: "This expert has opted out and cannot be contacted.",
  email_suppressed: "This address is on the suppression list and cannot be contacted.",
  request_closed: "This request is closed.",
  already_invited: "This expert has already been invited to this request.",
  over_budget: "Inviting this expert would exceed the request's honorarium budget.",
};

export const honorariumFor = (mode: ExpertMode) => HONORARIUM_CENTS[mode];

/** Cold = agent-researched contacts, which count against the daily limit. Opt-in and nominated are not cold. */
export const isColdSource = (source: string): boolean => source === ("agent_researched" satisfies ExpertSource);

export type AnswerCheck = { ok: true } | { ok: false; error: string };
/** Answers must reference existing questions, once each. */
export function validateAnswerIndexes(questionCount: number, answers: { questionIndex: number }[]): AnswerCheck {
  const seen = new Set<number>();
  for (const a of answers) {
    if (a.questionIndex < 0 || a.questionIndex >= questionCount) return { ok: false, error: `Unknown question ${a.questionIndex + 1}` };
    if (seen.has(a.questionIndex)) return { ok: false, error: `Question ${a.questionIndex + 1} answered twice` };
    seen.add(a.questionIndex);
  }
  return { ok: true };
}

export interface PublicQuestionnaire {
  status: "open";
  domain: string;
  purpose: string;
  questions: string[];
  honorariumCents: number;
  mode: string;
  expiresAt: string;
}
/**
 * Whitelist projection for the public questionnaire. Never spread a DB row here: job ids, budgets,
 * customer data and expert contact details must not leak (guardrail 5).
 */
export function toPublicQuestionnaire(
  request: { domain: string; purpose: string; questions: unknown },
  engagement: { honorariumCents: number; mode: string; expiresAt: Date },
): PublicQuestionnaire {
  const questions = Array.isArray(request.questions) ? request.questions.filter((q): q is string => typeof q === "string") : [];
  return {
    status: "open",
    domain: request.domain,
    purpose: request.purpose,
    questions,
    honorariumCents: engagement.honorariumCents,
    mode: engagement.mode,
    expiresAt: engagement.expiresAt.toISOString(),
  };
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/** Honest first-contact copy: who we are, that an AI agent wrote it, why, what we pay, how to opt out. */
export function buildInviteEmail(input: {
  expertName: string; domain: string; purpose: string; questionCount: number;
  honorariumCents: number; questionnaireUrl: string; optOutUrl: string; companyAddress: string;
}): { subject: string; body: string } {
  const first = input.expertName.trim().split(/\s+/)[0] || "there";
  return {
    subject: `Paid expert review request from Autonomous Evals: ${input.domain}`,
    body: [
      `Hi ${first},`,
      "",
      "This message is from Autonomous Evals and was written by an AI agent working for us. A human founder reviewed and approved it before it was sent.",
      "",
      `We build evaluations for AI agents. We would like a working professional in ${input.domain} to answer ${input.questionCount} short question${input.questionCount === 1 ? "" : "s"}, so our tests reflect what correct looks like in your field.`,
      "",
      `What the answers are for: ${input.purpose}`,
      `Your answers are stored by Autonomous Evals and used as reference material for those evaluations. Nothing is attributed to you by name without your explicit consent.`,
      "",
      `Honorarium: ${dollars(input.honorariumCents)}, paid manually after you submit.`,
      "",
      `Answer here, in your own time: ${input.questionnaireUrl}`,
      "",
      "No reply is needed if you are not interested. To never hear from us again, opt out in one click:",
      input.optOutUrl,
      "",
      "Autonomous Evals",
      input.companyAddress,
    ].join("\n"),
  };
}

import "server-only";
import { and, asc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { isEmailConfigured, sendEmail, type SentEmail } from "@ae/core/auth/email";
import { newToken, hashToken } from "@ae/core/auth/tokens";
import { MONITORING_PRICE_CENTS_MONTHLY } from "@ae/core/contracts/index";
import { addMessage } from "./job-store";
import { recordEmailThread } from "./email-threads";
import { runOwnerLifecycle } from "./owner-lifecycle";
import { runOperatorDigest } from "./operator-digest";

// ---- policy constants ---------------------------------------------------------------------------

export const CLARIFICATION_IDLE_MS = 60 * 60 * 1000;
export const QUOTE_IDLE_MS = 3 * 60 * 60 * 1000;
export const PITCH_DELAY_MS = 24 * 60 * 60 * 1000;
export const EXPERT_REMINDER_DELAY_MS = 24 * 60 * 60 * 1000;
export const BATCH_LIMIT = 50;
export const DEADLINE_MS = 250_000;

export type FollowUpKind = "clarification_nudge" | "quote_reminder" | "monitoring_pitch" | "expert_reminder";
export type FollowUpEnv = Record<string, string | undefined>;

export interface FollowUpResult { processed: number; sent: number; skipped: number; errors: string[] }

const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const companyAddress = () => process.env.COMPANY_ADDRESS?.trim() || "[physical mailing address: set COMPANY_ADDRESS]";
const jobUrl = (jobId: string) => `${appUrl()}/jobs/${jobId}`;
const firstName = (name: string | null | undefined) => name?.trim().split(/\s+/)[0] || "there";
const toDate = (v: Date | string | null | undefined): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- pure selection helpers (exported for tests) ------------------------------------------------

/** Strictly older than `ms` before `now`; a null reference is never "old". */
export function isOlderThan(ref: Date | null, ms: number, now: Date): boolean {
  return !!ref && now.getTime() - ref.getTime() > ms;
}

const maxDate = (...ds: (Date | null)[]): Date | null =>
  ds.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);

/** Mock jobs and internal-fixture customers are never emailed unless FOLLOWUPS_INCLUDE_MOCK=1. */
export function jobEmailAllowed(j: { isMock: boolean; isInternalFixture: boolean }, env: FollowUpEnv = process.env): boolean {
  if (env.FOLLOWUPS_INCLUDE_MOCK === "1") return true;
  return !j.isMock && !j.isInternalFixture;
}

/**
 * Reference time = most recent of the customer's last message and our last commercial question;
 * with neither, job.updatedAt. The nudge is due once that is more than 60 minutes old.
 */
export function clarificationNudgeDue(
  j: { state: string; updatedAt: Date; lastCustomerAt: Date | null; lastCommercialAt: Date | null }, now: Date,
): boolean {
  if (j.state !== "needs_clarification") return false;
  return isOlderThan(maxDate(j.lastCustomerAt, j.lastCommercialAt) ?? j.updatedAt, CLARIFICATION_IDLE_MS, now);
}

/**
 * Reference time = the later of the latest quote's createdAt and job.updatedAt (updatedAt moves when the job
 * enters quoted/awaiting_payment, a new quote moves createdAt), so we never remind early. Due after 3 hours.
 */
export function quoteReminderDue(
  j: { state: string; updatedAt: Date; latestQuoteAt: Date | null }, now: Date,
): boolean {
  if (j.state !== "quoted" && j.state !== "awaiting_payment") return false;
  return isOlderThan(maxDate(j.latestQuoteAt, j.updatedAt), QUOTE_IDLE_MS, now);
}

/** Delivered >24h ago, a frozen suite exists (not trace_audit), no subscription row, live env (or MONITORING_PITCH_TEST=1). */
export function monitoringPitchDue(
  j: { state: string; package: string; environment: string; deliveredAt: Date | null; hasSubscription: boolean },
  now: Date, env: FollowUpEnv = process.env,
): boolean {
  if (j.state !== "delivered" || j.package === "trace_audit" || j.hasSubscription) return false;
  if (j.environment !== "live" && env.MONITORING_PITCH_TEST !== "1") return false;
  return isOlderThan(j.deliveredAt, PITCH_DELAY_MS, now);
}

/** Invited >24h ago (since the invite was sent), still unanswered, not expired, expert not opted out. */
export function expertReminderDue(
  e: { status: string; invitedAt: Date; expiresAt: Date; expertStatus: string }, now: Date,
): boolean {
  if (e.status !== "invited" || e.expertStatus === "opted_out") return false;
  if (e.expiresAt.getTime() <= now.getTime()) return false;
  return isOlderThan(e.invitedAt, EXPERT_REMINDER_DELAY_MS, now);
}

// ---- email copy (short, plain text, honest about who/what sends it) -----------------------------

const SIGNOFF = "Standard Evals (this message was written and sent by our AI agent)";

export const formatMonthlyPrice = (cents: number = MONITORING_PRICE_CENTS_MONTHLY) =>
  `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}/month`;

export function buildClarificationNudge(name: string | null, link: string) {
  return {
    subject: "Quick question still open on your Standard Evals job",
    text: [
      `Hi ${firstName(name)},`,
      "",
      "We are waiting on an answer to our clarifying question before we can quote your job. No rush, but a short reply is all we need to move forward.",
      `You can answer by replying here or on the job page: ${link}`,
      "",
      SIGNOFF,
    ].join("\n"),
  };
}

export function buildQuoteReminder(name: string | null, link: string) {
  return {
    subject: "Your Standard Evals quote is ready when you are",
    text: [
      `Hi ${firstName(name)},`,
      "",
      "A friendly reminder that your quote is waiting for you. You can review it, and accept it when ready, here:",
      link,
      "",
      "If this no longer fits, you can ignore this message. We will not send another reminder.",
      "",
      SIGNOFF,
    ].join("\n"),
  };
}

export function buildMonitoringPitch(name: string | null, link: string, priceCents: number = MONITORING_PRICE_CENTS_MONTHLY) {
  return {
    subject: "Keep your agent tested: nightly regression monitoring",
    text: [
      `Hi ${firstName(name)},`,
      "",
      "Your evaluation was delivered yesterday. If you would like to catch regressions as your agent changes, we can re-run the frozen test suite from your job every night and email you if anything that used to pass now fails.",
      `Price: ${formatMonthlyPrice(priceCents)}. You can start it from the job page: ${link}`,
      "",
      "This is a one-time suggestion; we will not send another.",
      "",
      SIGNOFF,
    ].join("\n"),
  };
}

export function buildExpertReminder(
  i: { name: string; domain: string; questionnaireUrl: string; optOutUrl: string; companyAddress: string },
) {
  return {
    subject: `Reminder: paid expert question from Standard Evals (${i.domain})`,
    text: [
      `Hi ${firstName(i.name)},`,
      "",
      "This is a one-time reminder from Standard Evals, written and sent by our AI agent. A few days ago we invited you to answer a short paid questionnaire about " + i.domain + ".",
      `Answer here, in your own time: ${i.questionnaireUrl}`,
      "(This link replaces the one in our earlier email.)",
      "",
      "No reply is needed if you are not interested. To never hear from us again, opt out in one click:",
      i.optOutUrl,
      "",
      "Standard Evals",
      i.companyAddress,
    ].join("\n"),
  };
}

// ---- persistence helpers ------------------------------------------------------------------------

async function isSuppressedEmail(email: string): Promise<boolean> {
  const [row] = await db().select({ id: schema.contactSuppressions.id }).from(schema.contactSuppressions)
    .where(sql`lower(${schema.contactSuppressions.email}) = ${email.trim().toLowerCase()}`).limit(1);
  return !!row;
}

async function claim(subjectType: string, subjectId: string, kind: FollowUpKind): Promise<boolean> {
  const rows = await db().insert(schema.followUps).values({ subjectType, subjectId, kind })
    .onConflictDoNothing().returning({ id: schema.followUps.id });
  return rows.length > 0;
}

async function releaseClaim(subjectType: string, subjectId: string, kind: FollowUpKind): Promise<void> {
  const f = schema.followUps;
  await db().delete(f).where(and(eq(f.subjectType, subjectType), eq(f.subjectId, subjectId), eq(f.kind, kind)));
}

interface Delivery {
  subjectType: "job" | "expert_engagement";
  subjectId: string;
  kind: FollowUpKind;
  to: string;
  /** Runs after the claim is won; may return null to abandon (claim is released). `undo` runs if sending fails. */
  compose: () => Promise<{ subject: string; text: string; undo?: () => Promise<void> } | null>;
  /** Runs after a successful send. Failures here are recorded but the claim is kept (the email went out). */
  afterSend: (sent: SentEmail, text: string) => Promise<void>;
}

/** Claim -> send -> (release claim on failure). Returns "sent" | "skipped"; throws only never (errors are pushed). */
async function deliver(d: Delivery, r: FollowUpResult): Promise<void> {
  const label = `${d.subjectType}:${d.subjectId}`;
  if (!isEmailConfigured() || (await isSuppressedEmail(d.to))) { r.skipped++; return; }
  if (!(await claim(d.subjectType, d.subjectId, d.kind))) { r.skipped++; return; }

  let composed: Awaited<ReturnType<Delivery["compose"]>> = null;
  let sent: SentEmail;
  try {
    composed = await d.compose();
    if (!composed) { await releaseClaim(d.subjectType, d.subjectId, d.kind); r.skipped++; return; }
    sent = await sendEmail({ to: d.to, subject: composed.subject, text: composed.text, purpose: "commercial", labels: ["follow_up", d.kind] });
  } catch (err) {
    r.errors.push(`${label}: ${d.kind} failed: ${errMsg(err)}`);
    try { await composed?.undo?.(); await releaseClaim(d.subjectType, d.subjectId, d.kind); }
    catch (e2) { r.errors.push(`${label}: cleanup failed: ${errMsg(e2)}`); }
    return;
  }
  r.sent++;
  try { await d.afterSend(sent, composed.text); }
  catch (err) { r.errors.push(`${label}: post-send bookkeeping failed: ${errMsg(err)}`); }
}

// ---- candidate queries --------------------------------------------------------------------------

interface JobCandidate {
  id: string; state: string; package: string; environment: string; isMock: boolean; isInternalFixture: boolean;
  updatedAt: Date; deliveredAt: Date | null; email: string; name: string | null;
  lastCustomerAt: Date | null; lastCommercialAt: Date | null; latestQuoteAt: Date | null; hasSubscription: boolean;
}

const iso = (d: Date) => d.toISOString();

async function jobCandidates(kind: FollowUpKind, now: Date, env: FollowUpEnv): Promise<JobCandidate[]> {
  const { jobs: j, customers: c, messages: m, quotes: q, followUps: f, monitoringSubscriptions: s } = schema;
  const lastMsg = (role: string) => sql<Date | string | null>`(select max(${m.createdAt}) from ${m} where ${m.jobId} = ${j.id} and ${m.role} = ${role})`;
  const lastCustomer = lastMsg("customer");
  const lastCommercial = lastMsg("commercial");
  const latestQuote = sql<Date | string | null>`(select max(${q.createdAt}) from ${q} where ${q.jobId} = ${j.id})`;
  const hasSub = sql<boolean>`exists (select 1 from ${s} where ${s.jobId} = ${j.id})`;
  const notFollowed = sql`not exists (select 1 from ${f} where ${f.subjectType} = 'job' and ${f.subjectId} = ${j.id} and ${f.kind} = ${kind})`;

  const cutoff = (ms: number) => iso(new Date(now.getTime() - ms));
  const conds = [notFollowed];
  if (env.FOLLOWUPS_INCLUDE_MOCK !== "1") conds.push(eq(j.isMock, false), eq(c.isInternalFixture, false));
  if (kind === "clarification_nudge") {
    conds.push(eq(j.state, "needs_clarification"),
      sql`coalesce(greatest(${lastCustomer}, ${lastCommercial}), ${j.updatedAt}) < ${cutoff(CLARIFICATION_IDLE_MS)}::timestamptz`);
  } else if (kind === "quote_reminder") {
    conds.push(inArray(j.state, ["quoted", "awaiting_payment"]), lt(j.updatedAt, new Date(now.getTime() - QUOTE_IDLE_MS)),
      sql`(${latestQuote} is null or ${latestQuote} < ${cutoff(QUOTE_IDLE_MS)}::timestamptz)`);
  } else {
    conds.push(eq(j.state, "delivered"), ne(j.package, "trace_audit"), lt(j.deliveredAt, new Date(now.getTime() - PITCH_DELAY_MS)),
      sql`not ${hasSub}`);
    if (env.MONITORING_PITCH_TEST !== "1") conds.push(eq(j.environment, "live"));
  }

  const rows = await db().select({
    id: j.id, state: j.state, package: j.package, environment: j.environment, isMock: j.isMock,
    isInternalFixture: c.isInternalFixture, updatedAt: j.updatedAt, deliveredAt: j.deliveredAt,
    email: c.email, name: c.name,
    lastCustomerAt: lastCustomer, lastCommercialAt: lastCommercial, latestQuoteAt: latestQuote, hasSubscription: hasSub,
  }).from(j).innerJoin(c, eq(c.id, j.customerId)).where(and(...conds)).orderBy(asc(j.updatedAt)).limit(BATCH_LIMIT);

  return rows.map((r) => ({
    ...r, updatedAt: toDate(r.updatedAt)!, deliveredAt: toDate(r.deliveredAt),
    lastCustomerAt: toDate(r.lastCustomerAt), lastCommercialAt: toDate(r.lastCommercialAt), latestQuoteAt: toDate(r.latestQuoteAt),
  }));
}

interface ExpertCandidate {
  id: string; status: string; expiresAt: Date; invitedAt: Date; tokenHash: string;
  expertEmail: string; expertName: string; expertStatus: string; domain: string;
}

async function expertCandidates(now: Date): Promise<ExpertCandidate[]> {
  const { expertEngagements: e, expertRequests: r, experts: x, outreachDrafts: d, followUps: f } = schema;
  const invitedAt = sql<Date | string>`coalesce(${d.sentAt}, ${e.createdAt})`;
  const rows = await db().select({
    id: e.id, status: e.status, expiresAt: e.expiresAt, invitedAt, tokenHash: e.tokenHash,
    expertEmail: x.email, expertName: x.name, expertStatus: x.status, domain: r.domain,
  }).from(e)
    .innerJoin(r, eq(r.id, e.requestId)).innerJoin(x, eq(x.id, e.expertId)).innerJoin(d, eq(d.id, e.outreachDraftId))
    .where(and(
      eq(e.status, "invited"), eq(r.status, "open"), ne(x.status, "opted_out"),
      // Call-mode / booked engagements keep their original token: booking, .ics and cancel links must not die.
      eq(e.mode, "async"), isNull(e.scheduledAt),
      eq(d.status, "sent"), // never remind an invite a founder has not approved and sent
      sql`${e.expiresAt} > ${iso(now)}::timestamptz`,
      sql`${invitedAt} < ${iso(new Date(now.getTime() - EXPERT_REMINDER_DELAY_MS))}::timestamptz`,
      sql`not exists (select 1 from ${f} where ${f.subjectType} = 'expert_engagement' and ${f.subjectId} = ${e.id} and ${f.kind} = 'expert_reminder')`,
    )).orderBy(asc(e.createdAt)).limit(BATCH_LIMIT);
  return rows.map((row) => ({ ...row, expiresAt: toDate(row.expiresAt)!, invitedAt: toDate(row.invitedAt)! }));
}

// ---- runner -------------------------------------------------------------------------------------

const JOB_RULES: { kind: FollowUpKind; due: (j: JobCandidate, now: Date, env: FollowUpEnv) => boolean;
  build: (j: JobCandidate) => { subject: string; text: string } }[] = [
  { kind: "clarification_nudge", due: (j, n) => clarificationNudgeDue(j, n), build: (j) => buildClarificationNudge(j.name, jobUrl(j.id)) },
  { kind: "quote_reminder", due: (j, n) => quoteReminderDue(j, n), build: (j) => buildQuoteReminder(j.name, jobUrl(j.id)) },
  { kind: "monitoring_pitch", due: monitoringPitchDue, build: (j) => buildMonitoringPitch(j.name, jobUrl(j.id)) },
];

async function runJobRule(rule: (typeof JOB_RULES)[number], now: Date, env: FollowUpEnv, deadline: number, r: FollowUpResult) {
  let candidates: JobCandidate[];
  try { candidates = await jobCandidates(rule.kind, now, env); }
  catch (err) { r.errors.push(`${rule.kind}:query: ${errMsg(err)}`); return; }
  for (const j of candidates) {
    if (Date.now() > deadline) return;
    r.processed++;
    if (!jobEmailAllowed(j, env) || !rule.due(j, now, env)) { r.skipped++; continue; }
    try {
      await deliver({
        subjectType: "job", subjectId: j.id, kind: rule.kind, to: j.email,
        compose: async () => rule.build(j),
        afterSend: async (sent, text) => {
          await recordEmailThread(sent.threadId, "job", { jobId: j.id });
          await addMessage(j.id, "commercial", text);
        },
      }, r);
    } catch (err) { r.errors.push(`job:${j.id}: ${errMsg(err)}`); }
  }
}

async function runExpertRule(now: Date, deadline: number, r: FollowUpResult) {
  let candidates: ExpertCandidate[];
  try { candidates = await expertCandidates(now); }
  catch (err) { r.errors.push(`expert_reminder:query: ${errMsg(err)}`); return; }
  const e = schema.expertEngagements;
  for (const c of candidates) {
    if (Date.now() > deadline) return;
    r.processed++;
    if (!expertReminderDue(c, now)) { r.skipped++; continue; }
    try {
      await deliver({
        subjectType: "expert_engagement", subjectId: c.id, kind: "expert_reminder", to: c.expertEmail,
        // Tokens are stored hashed, so links cannot be rebuilt: rotate to a fresh token (undone if the send fails).
        compose: async () => {
          const token = newToken();
          // The old hash is kept so the ORIGINAL invite's opt-out link keeps working (CAN-SPAM).
          const rotated = await db().update(e)
            .set({ tokenHash: hashToken(token), previousTokenHashes: sql`array_append(${e.previousTokenHashes}, ${c.tokenHash})` })
            .where(and(eq(e.id, c.id), eq(e.status, "invited"), eq(e.tokenHash, c.tokenHash), eq(e.mode, "async"), isNull(e.scheduledAt)))
            .returning({ id: e.id });
          if (rotated.length === 0) return null; // answered/cancelled/changed meanwhile
          const mail = buildExpertReminder({
            name: c.expertName, domain: c.domain, companyAddress: companyAddress(),
            questionnaireUrl: `${appUrl()}/expert/r/${token}`, optOutUrl: `${appUrl()}/expert/opt-out/${token}`,
          });
          return { ...mail, undo: async () => {
            await db().update(e).set({ tokenHash: c.tokenHash, previousTokenHashes: sql`array_remove(${e.previousTokenHashes}, ${c.tokenHash})` })
              .where(eq(e.id, c.id));
          }};
        },
        afterSend: async (sent) => { await recordEmailThread(sent.threadId, "expert_outreach", { expertEngagementId: c.id }); },
      }, r);
    } catch (err) { r.errors.push(`expert_engagement:${c.id}: ${errMsg(err)}`); }
  }
}

export async function runFollowUps(opts: { now?: Date } = {}): Promise<FollowUpResult> {
  const now = opts.now ?? new Date();
  const env = process.env as FollowUpEnv;
  const deadline = Date.now() + DEADLINE_MS;
  const result: FollowUpResult = { processed: 0, sent: 0, skipped: 0, errors: [] };
  for (const rule of JOB_RULES) await runJobRule(rule, now, env, deadline, result);
  await runExpertRule(now, deadline, result);
  // Agent-owner autopilot: results / re-run / fix-offer emails for owner-submitted agents, then the daily operator digest.
  try {
    const o = await runOwnerLifecycle({ now, deadline });
    result.processed += o.processed; result.sent += o.sent; result.skipped += o.skipped; result.errors.push(...o.errors);
  } catch (err) { result.errors.push(`owner_lifecycle: ${errMsg(err)}`); }
  try {
    const d = await runOperatorDigest(now);
    if (d.sent) result.sent++;
  } catch (err) { result.errors.push(`operator_digest: ${errMsg(err)}`); }
  return result;
}

import "server-only";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { hashToken, newToken } from "@ae/core/auth/tokens";
import {
  ExpertRequest, ExpertSignup, HONORARIUM_CENTS, type ExpertMode, type ExpertSource, type QuestionnaireAnswers,
} from "@ae/core/contracts/experts";
import { recordProgress } from "./job-store";
import {
  COLD_CONTACTS_PER_DAY, ENGAGEMENT_TTL_MS, INVITE_BLOCK_MESSAGE, buildInviteEmail, checkEngagementToken,
  coldContactRateLimit, inviteBlockReason, isColdSource, normalizeEmail, startOfUtcDay, toPublicQuestionnaire,
  validateAnswerIndexes, type PublicQuestionnaire, type TokenCheck,
} from "./experts-logic";

export class ExpertError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const companyAddress = () => process.env.COMPANY_ADDRESS?.trim() || "[physical mailing address: set COMPANY_ADDRESS]";

// ---- suppression --------------------------------------------------------------------------------

/** Global do-not-contact check. Must run before every send. */
export async function isSuppressed(email: string): Promise<boolean> {
  const [row] = await db().select({ id: schema.contactSuppressions.id }).from(schema.contactSuppressions)
    .where(sql`lower(${schema.contactSuppressions.email}) = ${normalizeEmail(email)}`).limit(1);
  return !!row;
}

async function suppress(email: string, reason: string) {
  await db().insert(schema.contactSuppressions)
    .values({ email: normalizeEmail(email), reason }).onConflictDoNothing();
}

/** Opt out by engagement token (always works, even when expired/used) or by email. Idempotent. */
export async function optOut(target: { token: string } | { email: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  let email: string;
  if ("token" in target) {
    const [row] = await db().select({ email: schema.experts.email })
      .from(schema.expertEngagements)
      .innerJoin(schema.experts, eq(schema.experts.id, schema.expertEngagements.expertId))
      .where(eq(schema.expertEngagements.tokenHash, hashToken(target.token))).limit(1);
    if (!row) return { ok: false, error: "This opt-out link is not valid." };
    email = row.email;
  } else {
    email = target.email;
  }
  await suppress(email, "opt_out");
  const experts = await db().update(schema.experts).set({ status: "opted_out" })
    .where(sql`lower(${schema.experts.email}) = ${normalizeEmail(email)}`).returning({ id: schema.experts.id });
  if (experts.length > 0) {
    const cancelled = await db().update(schema.expertEngagements).set({ status: "cancelled", scheduledAt: null })
      .where(and(inArray(schema.expertEngagements.expertId, experts.map((e) => e.id)), eq(schema.expertEngagements.status, "invited")))
      .returning({ id: schema.expertEngagements.id });
    // Free any call slots they held so they can be re-offered.
    if (cancelled.length > 0) {
      await db().update(schema.callSlots).set({ takenByEngagementId: null })
        .where(inArray(schema.callSlots.takenByEngagementId, cancelled.map((c) => c.id)));
    }
  }
  return { ok: true };
}

// ---- experts & requests -------------------------------------------------------------------------

export type SignupResult = { status: "created" | "exists" } | { status: "suppressed" };

/** Opt-in signup. Dedupes by lower(email); never overwrites an existing profile. */
export async function createExpertFromSignup(input: ExpertSignup, source: ExpertSource = "opt_in"): Promise<SignupResult> {
  const data = ExpertSignup.parse(input);
  const email = normalizeEmail(data.email);
  if (await isSuppressed(email)) return { status: "suppressed" };
  const rows = await db().insert(schema.experts).values({
    email, name: data.name, title: data.title, organization: data.organization ?? null,
    domains: data.domains, profileUrl: data.profileUrl ?? null, source,
    rateCents: data.rateCents ?? null, availability: data.availability, consentFlags: data.consents,
  }).onConflictDoNothing().returning({ id: schema.experts.id });
  return { status: rows.length > 0 ? "created" : "exists" };
}

export async function createExpertRequest(input: ExpertRequest, requestedByAgentSession?: string) {
  const data = ExpertRequest.parse(input);
  const [row] = await db().insert(schema.expertRequests).values({
    jobId: data.jobId ?? null, domain: data.domain, questions: data.questions, purpose: data.purpose,
    maxBudgetCents: data.maxBudgetCents, requestedByAgentSession: requestedByAgentSession ?? null,
  }).returning();
  return row!;
}

// ---- invite -------------------------------------------------------------------------------------

/**
 * Creates the engagement (token hash only) and a PENDING outreach draft. The email is sent only when
 * a founder approves the draft via /api/operator/outreach/[id]/approve; nothing here sends mail.
 */
export async function inviteExpert(requestId: string, expertId: string, mode: ExpertMode = "async") {
  const d = db();
  const [[request], [expert]] = await Promise.all([
    d.select().from(schema.expertRequests).where(eq(schema.expertRequests.id, requestId)).limit(1),
    d.select().from(schema.experts).where(eq(schema.experts.id, expertId)).limit(1),
  ]);
  if (!request) throw new ExpertError(404, "Request not found");
  if (!expert) throw new ExpertError(404, "Expert not found");

  const [existing, committed, suppressed] = await Promise.all([
    d.select({ id: schema.expertEngagements.id }).from(schema.expertEngagements)
      .where(and(eq(schema.expertEngagements.requestId, requestId), eq(schema.expertEngagements.expertId, expertId))).limit(1),
    d.select({ s: sql<number>`coalesce(sum(${schema.expertEngagements.honorariumCents}), 0)::int` }).from(schema.expertEngagements)
      .where(and(eq(schema.expertEngagements.requestId, requestId), sql`${schema.expertEngagements.status} <> 'cancelled'`)),
    isSuppressed(expert.email),
  ]);
  const honorariumCents = HONORARIUM_CENTS[mode];
  const block = inviteBlockReason({
    expertStatus: expert.status, suppressed, requestStatus: request.status, alreadyInvited: existing.length > 0,
    committedCents: Number(committed[0]?.s ?? 0), honorariumCents, maxBudgetCents: request.maxBudgetCents,
  });
  if (block) throw new ExpertError(block === "already_invited" ? 409 : 422, INVITE_BLOCK_MESSAGE[block]);

  const token = newToken();
  const questions = Array.isArray(request.questions) ? (request.questions as string[]) : [];
  const { subject, body } = buildInviteEmail({
    expertName: expert.name, domain: request.domain, purpose: request.purpose, questionCount: questions.length,
    honorariumCents, questionnaireUrl: `${appUrl()}/expert/r/${token}`,
    optOutUrl: `${appUrl()}/expert/opt-out/${token}`, companyAddress: companyAddress(),
  });

  const [draft] = await d.insert(schema.outreachDrafts)
    .values({ toEmail: expert.email, subject, body, status: "pending" }).returning({ id: schema.outreachDrafts.id });
  try {
    const [engagement] = await d.insert(schema.expertEngagements).values({
      requestId, expertId, mode, tokenHash: hashToken(token), honorariumCents,
      expiresAt: new Date(Date.now() + ENGAGEMENT_TTL_MS), outreachDraftId: draft!.id,
    }).returning({ id: schema.expertEngagements.id });
    return { engagementId: engagement!.id, outreachDraftId: draft!.id };
  } catch (err) {
    // Lost a race on (request, expert): drop the orphan draft so it can't be approved.
    await d.update(schema.outreachDrafts).set({ status: "rejected", approvedBy: "system" }).where(eq(schema.outreachDrafts.id, draft!.id));
    if (/expert_engagements_req_expert_uq|duplicate key/i.test(String((err as Error)?.message) + String((err as { cause?: Error })?.cause?.message))) {
      throw new ExpertError(409, INVITE_BLOCK_MESSAGE.already_invited);
    }
    throw err;
  }
}

// ---- send guard (wired into the operator approve route) -----------------------------------------

export async function coldContactsApprovedToday(now = new Date()): Promise<number> {
  const [r] = await db().select({ n: sql<number>`count(*)::int` })
    .from(schema.expertEngagements)
    .innerJoin(schema.experts, eq(schema.experts.id, schema.expertEngagements.expertId))
    .innerJoin(schema.outreachDrafts, eq(schema.outreachDrafts.id, schema.expertEngagements.outreachDraftId))
    .where(and(
      eq(schema.experts.source, "agent_researched"),
      inArray(schema.outreachDrafts.status, ["approved", "sent"]),
      gte(sql`coalesce(${schema.outreachDrafts.sentAt}, ${schema.outreachDrafts.createdAt})`, startOfUtcDay(now)),
    ));
  return Number(r?.n ?? 0);
}

export type SendGuard = { ok: true } | { ok: false; status: number; error: string };

/** Run before approving/sending any outreach draft: suppression for everyone, daily cap for cold expert contacts. */
export async function guardOutreachSend(draftId: string, toEmail: string): Promise<SendGuard> {
  if (await isSuppressed(toEmail)) {
    return { ok: false, status: 409, error: "Recipient is on the suppression list; this draft must not be sent. Reject it." };
  }
  const [link] = await db().select({ source: schema.experts.source })
    .from(schema.expertEngagements)
    .innerJoin(schema.experts, eq(schema.experts.id, schema.expertEngagements.expertId))
    .where(eq(schema.expertEngagements.outreachDraftId, draftId)).limit(1);
  if (link && isColdSource(link.source)) {
    const limit = coldContactRateLimit(await coldContactsApprovedToday());
    if (!limit.allowed) {
      return { ok: false, status: 429, error: `Daily cold-contact limit reached (${COLD_CONTACTS_PER_DAY}). Approve more tomorrow.` };
    }
  }
  return { ok: true };
}

// ---- questionnaire ------------------------------------------------------------------------------

async function findEngagement(token: string) {
  if (!token || token.length > 200) return null;
  const [row] = await db().select({ engagement: schema.expertEngagements, request: schema.expertRequests })
    .from(schema.expertEngagements)
    .innerJoin(schema.expertRequests, eq(schema.expertRequests.id, schema.expertEngagements.requestId))
    .where(eq(schema.expertEngagements.tokenHash, hashToken(token))).limit(1);
  return row ?? null;
}

export type QuestionnaireResult = { check: "ok"; questionnaire: PublicQuestionnaire } | { check: Exclude<TokenCheck, "ok"> };

export async function getQuestionnaire(token: string): Promise<QuestionnaireResult> {
  const row = await findEngagement(token);
  const check = checkEngagementToken(row?.engagement, new Date());
  if (check !== "ok" || !row) return { check: check === "ok" ? "not_found" : check };
  return { check: "ok", questionnaire: toPublicQuestionnaire(row.request, row.engagement) };
}

export type SubmitResult = { ok: true } | { ok: false; status: number; error: string };

export async function submitAnswers(token: string, answers: QuestionnaireAnswers["answers"]): Promise<SubmitResult> {
  const row = await findEngagement(token);
  const check = checkEngagementToken(row?.engagement, new Date());
  if (!row || check === "not_found") return { ok: false, status: 404, error: "This link is not valid." };
  if (check === "expired") return { ok: false, status: 410, error: "This link has expired." };
  if (check === "used") return { ok: false, status: 409, error: "These answers were already submitted." };
  if (check === "cancelled") return { ok: false, status: 410, error: "This invitation was cancelled." };

  const questions = Array.isArray(row.request.questions) ? row.request.questions : [];
  const valid = validateAnswerIndexes(questions.length, answers);
  if (!valid.ok) return { ok: false, status: 400, error: valid.error };

  const d = db();
  // Atomic claim: only one submission can move invited -> answered.
  const claimed = await d.update(schema.expertEngagements).set({ status: "answered", answeredAt: new Date() })
    .where(and(eq(schema.expertEngagements.id, row.engagement.id), eq(schema.expertEngagements.status, "invited")))
    .returning({ id: schema.expertEngagements.id });
  if (claimed.length === 0) return { ok: false, status: 409, error: "These answers were already submitted." };
  try {
    await d.insert(schema.expertResponses).values({
      engagementId: row.engagement.id, answers, provenance: "expert_sourced",
    });
  } catch (err) {
    await d.update(schema.expertEngagements).set({ status: "invited", answeredAt: null })
      .where(eq(schema.expertEngagements.id, row.engagement.id));
    throw err;
  }
  await d.update(schema.expertRequests).set({ status: "answered" })
    .where(and(eq(schema.expertRequests.id, row.request.id), eq(schema.expertRequests.status, "open")));
  if (row.request.jobId) {
    await recordProgress(row.request.jobId, "expert_response", `Expert input received for ${row.request.domain}.`);
  }
  return { ok: true };
}

// ---- operator -----------------------------------------------------------------------------------

export async function getExpertsOverview() {
  const d = db();
  const [requests, experts, engagements, responseCounts, suppressionRows] = await Promise.all([
    d.select().from(schema.expertRequests).orderBy(desc(schema.expertRequests.createdAt)).limit(200),
    d.select().from(schema.experts).orderBy(desc(schema.experts.createdAt)).limit(500),
    d.select({
      id: schema.expertEngagements.id, requestId: schema.expertEngagements.requestId, expertId: schema.expertEngagements.expertId,
      mode: schema.expertEngagements.mode, status: schema.expertEngagements.status,
      honorariumCents: schema.expertEngagements.honorariumCents, paidAt: schema.expertEngagements.paidAt,
      answeredAt: schema.expertEngagements.answeredAt, expiresAt: schema.expertEngagements.expiresAt,
      outreachDraftId: schema.expertEngagements.outreachDraftId, draftStatus: schema.outreachDrafts.status,
      createdAt: schema.expertEngagements.createdAt,
      recordingConsent: schema.expertEngagements.recordingConsent, scheduledAt: schema.expertEngagements.scheduledAt,
    }).from(schema.expertEngagements)
      .leftJoin(schema.outreachDrafts, eq(schema.outreachDrafts.id, schema.expertEngagements.outreachDraftId))
      .orderBy(desc(schema.expertEngagements.createdAt)).limit(500),
    d.select({ engagementId: schema.expertResponses.engagementId, answers: schema.expertResponses.answers })
      .from(schema.expertResponses).orderBy(desc(schema.expertResponses.createdAt)).limit(500),
    d.select({ n: sql<number>`count(*)::int` }).from(schema.contactSuppressions),
  ]);
  const answersByEngagement = new Map(responseCounts.map((r) => [r.engagementId, r.answers]));
  const owed = engagements.filter((e) => e.status === "answered" && !e.paidAt);
  return {
    requests,
    experts,
    engagements: engagements.map((e) => ({ ...e, answers: answersByEngagement.get(e.id) ?? null })),
    counts: {
      requests: requests.length, experts: experts.length, engagements: engagements.length,
      responses: responseCounts.length, suppressions: Number(suppressionRows[0]?.n ?? 0),
    },
    honorariaOwedCents: owed.reduce((s, e) => s + e.honorariumCents, 0),
    honorariaPaidCents: engagements.filter((e) => e.paidAt).reduce((s, e) => s + e.honorariumCents, 0),
    coldContactsToday: await coldContactsApprovedToday(),
    coldContactLimit: COLD_CONTACTS_PER_DAY,
  };
}

/** Honoraria are paid manually; this records that it happened (intervention + cost row). Idempotent. */
export async function markEngagementPaid(engagementId: string, operatorEmail: string) {
  const d = db();
  const [claimed] = await d.update(schema.expertEngagements).set({ status: "paid", paidAt: new Date() })
    .where(and(eq(schema.expertEngagements.id, engagementId), eq(schema.expertEngagements.status, "answered")))
    .returning();
  if (!claimed) {
    const [e] = await d.select({ status: schema.expertEngagements.status }).from(schema.expertEngagements)
      .where(eq(schema.expertEngagements.id, engagementId)).limit(1);
    throw e ? new ExpertError(409, `Engagement is ${e.status}; only answered engagements can be marked paid`) : new ExpertError(404, "Engagement not found");
  }
  const [request] = await d.select({ jobId: schema.expertRequests.jobId }).from(schema.expertRequests)
    .where(eq(schema.expertRequests.id, claimed.requestId)).limit(1);
  const jobId = request?.jobId ?? null;
  await d.insert(schema.interventions).values({
    jobId, operatorEmail, kind: "other",
    note: `honorarium paid: engagement ${engagementId}, expert ${claimed.expertId}, ${claimed.honorariumCents} cents`,
  });
  await d.insert(schema.costs).values({
    jobId, source: "expert_honorarium", microUsd: claimed.honorariumCents * 10_000,
    meta: { engagementId, expertId: claimed.expertId, requestId: claimed.requestId },
  });
  return claimed;
}

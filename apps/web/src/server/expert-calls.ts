import "server-only";
import { publicAppUrl } from "./public-url";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { hashToken, operatorEmails } from "@ae/core/auth/tokens";
import { sendEmail } from "@ae/core/auth/email";
import { putJobArtifact } from "@ae/core/storage/blob";
import { ExpertError, isSuppressed } from "./experts";
import { buildIcs, type IcsEvent } from "./ics";
import {
  BOOKING_BLOCK_STATUS, MIN_SLOT_LEAD_MS, bookingBlock, buildCallEmail, buildCancelEmail, checkNoteStorage,
  icsDescription, icsUid, newMeetUrl, slotStartError,
} from "./expert-calls-logic";

const appUrl = (): string => publicAppUrl();
const companyAddress = () => process.env.COMPANY_ADDRESS?.trim() || "[physical mailing address: set COMPANY_ADDRESS]";
const ICS_TYPE = "text/calendar; charset=utf-8";

// ---- the atomic claim ---------------------------------------------------------------------------

/**
 * The ONE statement that books (or reschedules to) a slot, atomically with the engagement update:
 *  - claims the slot only if it is free, in the future, AND the engagement still holds `priorSlotId` (optimistic
 *    check: a concurrent booking of the same engagement makes this one lose instead of releasing the other's slot),
 *  - frees any other slot the engagement holds, and writes scheduled_at / calendar_event_id / recording_consent,
 *  - all gated on the claim having succeeded (zero rows back = lost).
 * Run it after lockEngagementStatement in one db().batch so it reads a snapshot taken after the lock.
 * Exported (unexecuted) so tests can assert the SQL shape.
 */
export function bookSlotStatement(
  slotId: string, engagementId: string, priorSlotId: string | null, meetUrl: string, recordingConsent: boolean, now = new Date(),
) {
  const cutoff = new Date(now.getTime() + MIN_SLOT_LEAD_MS).toISOString();
  return sql`
    with claim as (
      update call_slots set taken_by_engagement_id = ${engagementId}
      where id = ${slotId} and taken_by_engagement_id is null and starts_at > ${cutoff}::timestamptz
        and (select id from call_slots where taken_by_engagement_id = ${engagementId} limit 1) is not distinct from ${priorSlotId}::uuid
      returning id, starts_at, duration_min
    ), freed as (
      update call_slots set taken_by_engagement_id = null
      where taken_by_engagement_id = ${engagementId} and id <> ${slotId} and exists (select 1 from claim)
      returning id
    ), eng as (
      update expert_engagements
      set scheduled_at = (select starts_at from claim), calendar_event_id = ${meetUrl}, recording_consent = ${recordingConsent}
      where id = ${engagementId} and exists (select 1 from claim)
      returning id
    )
    select id, starts_at, duration_min from claim`;
}

/** Per-engagement transaction-scoped advisory lock: serializes concurrent book requests for one engagement. */
export const lockEngagementStatement = (engagementId: string) => sql`select pg_advisory_xact_lock(hashtext(${engagementId}))`;

// ---- loading ------------------------------------------------------------------------------------

async function loadByToken(token: string) {
  if (!token || token.length > 200) return null;
  const [row] = await db().select({
    engagement: schema.expertEngagements, request: schema.expertRequests, expert: schema.experts,
  }).from(schema.expertEngagements)
    .innerJoin(schema.expertRequests, eq(schema.expertRequests.id, schema.expertEngagements.requestId))
    .innerJoin(schema.experts, eq(schema.experts.id, schema.expertEngagements.expertId))
    .where(eq(schema.expertEngagements.tokenHash, hashToken(token))).limit(1);
  return row ?? null;
}
type Loaded = NonNullable<Awaited<ReturnType<typeof loadByToken>>>;

async function loadBookable(token: string): Promise<Loaded> {
  const row = await loadByToken(token);
  const suppressed = row ? row.expert.status === "opted_out" || (await isSuppressed(row.expert.email)) : false;
  const block = bookingBlock(row?.engagement, suppressed);
  if (block || !row) { const [s, m] = BOOKING_BLOCK_STATUS[block ?? "not_found"]; throw new ExpertError(s, m); }
  return row;
}

async function currentSlot(engagementId: string) {
  const [s] = await db().select().from(schema.callSlots)
    .where(eq(schema.callSlots.takenByEngagementId, engagementId)).limit(1);
  return s ?? null;
}

export interface PublicBooking { slotId: string; startsAt: string; durationMin: number; meetUrl: string; recordingConsent: boolean }
const toBooking = (slot: { id: string; startsAt: Date; durationMin: number }, e: { calendarEventId: string | null; recordingConsent: boolean }): PublicBooking => ({
  slotId: slot.id, startsAt: slot.startsAt.toISOString(), durationMin: slot.durationMin,
  meetUrl: e.calendarEventId ?? "", recordingConsent: e.recordingConsent,
});

// ---- expert-facing ------------------------------------------------------------------------------

export async function listOpenSlots(token: string) {
  const row = await loadBookable(token);
  const open = await db().select({ id: schema.callSlots.id, startsAt: schema.callSlots.startsAt, durationMin: schema.callSlots.durationMin })
    .from(schema.callSlots)
    .where(and(isNull(schema.callSlots.takenByEngagementId), gt(schema.callSlots.startsAt, new Date(Date.now() + MIN_SLOT_LEAD_MS))))
    .orderBy(asc(schema.callSlots.startsAt)).limit(200);
  const mine = await currentSlot(row.engagement.id);
  return {
    slots: open.map((s) => ({ id: s.id, startsAt: s.startsAt.toISOString(), durationMin: s.durationMin })),
    booking: mine ? toBooking(mine, row.engagement) : null,
    domain: row.request.domain,
  };
}

function eventFor(row: Loaded, slot: { startsAt: Date; durationMin: number }, token: string, meetUrl: string, recordingConsent: boolean, method: "REQUEST" | "CANCEL"): IcsEvent {
  const optOutUrl = `${appUrl()}/expert/opt-out/${token}`;
  return {
    uid: icsUid(row.engagement.id), startsAt: slot.startsAt, durationMin: slot.durationMin,
    summary: `Standard Evals expert call (${row.request.domain})`,
    description: icsDescription({ meetUrl, recordingConsent, optOutUrl, domain: row.request.domain }),
    location: meetUrl, url: meetUrl, method, sequence: Math.floor(Date.now() / 1000),
    organizerEmail: process.env.AGENTMAIL_COMMERCIAL_INBOX_ID || [...operatorEmails()][0],
    attendeeEmails: [row.expert.email],
  };
}

export async function bookSlot(token: string, slotId: string, recordingConsent: boolean): Promise<PublicBooking & { emailed: { expert: boolean; operators: number } }> {
  const row = await loadBookable(token);
  const d = db();
  const engagementId = row.engagement.id;
  const prior = await currentSlot(engagementId);
  if (prior?.id === slotId) throw new ExpertError(409, "You already booked this slot.");

  const meetUrl = row.engagement.calendarEventId || newMeetUrl();
  const [, res] = await d.batch([
    d.execute(lockEngagementStatement(engagementId)),
    d.execute(bookSlotStatement(slotId, engagementId, prior?.id ?? null, meetUrl, recordingConsent)),
  ]);
  const claimed = res.rows[0] as { id: string; starts_at: string | Date; duration_min: number } | undefined;
  if (!claimed) throw new ExpertError(409, "That time was just taken, or your booking changed in another request. Please reload and pick again.");
  const slot = { id: claimed.id, startsAt: new Date(claimed.starts_at), durationMin: Number(claimed.duration_min) };

  const emailed = await sendInvites(row, token, slot, meetUrl, recordingConsent, !!prior);
  return { ...toBooking(slot, { calendarEventId: meetUrl, recordingConsent }), emailed };
}

async function sendInvites(row: Loaded, token: string, slot: { startsAt: Date; durationMin: number }, meetUrl: string, recordingConsent: boolean, rescheduled: boolean) {
  const optOutUrl = `${appUrl()}/expert/opt-out/${token}`;
  const base = {
    expertName: row.expert.name, domain: row.request.domain, startsAt: slot.startsAt, durationMin: slot.durationMin, meetUrl,
    recordingConsent, rescheduled, icsUrl: `${appUrl()}/api/expert/r/${token}/ics`, optOutUrl,
    companyAddress: companyAddress(), engagementId: row.engagement.id,
  };
  const ics = Buffer.from(buildIcs(eventFor(row, slot, token, meetUrl, recordingConsent, "REQUEST"))).toString("base64");
  const attachments = [{ filename: "invite.ics", contentType: "text/calendar; method=REQUEST; charset=utf-8", content: ics }];
  const out = { expert: false, operators: 0 };

  // Suppression is re-checked at send time: the expert could have opted out during this request.
  if (!(await isSuppressed(row.expert.email))) {
    try {
      const m = buildCallEmail({ ...base, audience: "expert" });
      await sendEmail({ to: row.expert.email, ...m, attachments, labels: ["expert-call"] });
      out.expert = true;
    } catch (err) { console.error("expert call invite (expert) failed", err); }
  }
  const m = buildCallEmail({ ...base, audience: "operator" });
  for (const to of operatorEmails()) {
    try { await sendEmail({ to, ...m, attachments, labels: ["expert-call"] }); out.operators++; }
    catch (err) { console.error("expert call invite (operator) failed", err); }
  }
  return out;
}

export async function cancelBooking(token: string) {
  const row = await loadBookable(token);
  const d = db();
  const released = await d.update(schema.callSlots).set({ takenByEngagementId: null })
    .where(eq(schema.callSlots.takenByEngagementId, row.engagement.id)).returning();
  if (released.length === 0) throw new ExpertError(409, "There is no booking to cancel.");
  await d.update(schema.expertEngagements).set({ scheduledAt: null, calendarEventId: null, recordingConsent: false })
    .where(eq(schema.expertEngagements.id, row.engagement.id));

  const slot = released[0]!;
  const optOutUrl = `${appUrl()}/expert/opt-out/${token}`;
  const common = { expertName: row.expert.name, domain: row.request.domain, startsAt: slot.startsAt, optOutUrl, companyAddress: companyAddress() };
  const cancelIcs = Buffer.from(buildIcs(eventFor(row, slot, token, row.engagement.calendarEventId ?? "", false, "CANCEL"))).toString("base64");
  const attachments = [{ filename: "cancel.ics", contentType: "text/calendar; method=CANCEL; charset=utf-8", content: cancelIcs }];
  if (!(await isSuppressed(row.expert.email))) {
    try { await sendEmail({ to: row.expert.email, ...buildCancelEmail({ ...common, audience: "expert" }), attachments, labels: ["expert-call"] }); }
    catch (err) { console.error("expert call cancel (expert) failed", err); }
  }
  for (const to of operatorEmails()) {
    try { await sendEmail({ to, ...buildCancelEmail({ ...common, audience: "operator" }), attachments, labels: ["expert-call"] }); }
    catch (err) { console.error("expert call cancel (operator) failed", err); }
  }
  return { ok: true as const };
}

/** .ics text for the expert's current booking. */
export async function getBookingIcs(token: string): Promise<string> {
  const row = await loadBookable(token);
  const slot = await currentSlot(row.engagement.id);
  if (!slot || !row.engagement.calendarEventId) throw new ExpertError(404, "There is no booking yet.");
  return buildIcs(eventFor(row, slot, token, row.engagement.calendarEventId, row.engagement.recordingConsent, "REQUEST"));
}

// ---- operator -----------------------------------------------------------------------------------

export async function addSlots(slots: { startsAt: string; durationMin: number }[]) {
  const now = new Date();
  const values = slots.map((s) => ({ startsAt: new Date(s.startsAt), durationMin: s.durationMin }));
  for (const v of values) {
    const err = slotStartError(v.startsAt, now);
    if (err) throw new ExpertError(400, err);
  }
  const rows = await db().insert(schema.callSlots).values(values).onConflictDoNothing().returning();
  return { created: rows.length, skippedDuplicates: values.length - rows.length, slots: rows };
}

export async function listAllSlots() {
  return db().select({
    id: schema.callSlots.id, startsAt: schema.callSlots.startsAt, durationMin: schema.callSlots.durationMin,
    takenByEngagementId: schema.callSlots.takenByEngagementId, expertName: schema.experts.name,
  }).from(schema.callSlots)
    .leftJoin(schema.expertEngagements, eq(schema.expertEngagements.id, schema.callSlots.takenByEngagementId))
    .leftJoin(schema.experts, eq(schema.experts.id, schema.expertEngagements.expertId))
    .where(gt(schema.callSlots.startsAt, sql`now() - interval '1 day'`))
    .orderBy(asc(schema.callSlots.startsAt)).limit(500);
}

export async function deleteSlot(id: string) {
  const deleted = await db().delete(schema.callSlots)
    .where(and(eq(schema.callSlots.id, id), isNull(schema.callSlots.takenByEngagementId))).returning({ id: schema.callSlots.id });
  if (deleted.length > 0) return;
  const [s] = await db().select({ id: schema.callSlots.id }).from(schema.callSlots).where(eq(schema.callSlots.id, id)).limit(1);
  throw s ? new ExpertError(409, "This slot is booked; the expert must cancel first.") : new ExpertError(404, "Slot not found");
}

/** Stores call notes (always) or a transcript (only with recording consent) as an expert_responses row. */
export async function addEngagementNotes(engagementId: string, input: { text: string; kind: "notes" | "transcript" }) {
  const d = db();
  const [e] = await d.select().from(schema.expertEngagements).where(eq(schema.expertEngagements.id, engagementId)).limit(1);
  if (!e) throw new ExpertError(404, "Engagement not found");
  if (e.status === "cancelled") throw new ExpertError(409, "Engagement was cancelled");
  const gate = checkNoteStorage(input.kind, e.recordingConsent);
  if (!gate.ok) throw new ExpertError(gate.status, gate.error);

  let transcriptBlobPath: string | null = null;
  let answers: Record<string, unknown>;
  if (input.kind === "transcript") {
    transcriptBlobPath = await putJobArtifact(`experts/${engagementId}`, "transcript", input.text, "text/plain");
    answers = { kind: "call_transcript", chars: input.text.length };
  } else {
    answers = { kind: "call_notes", text: input.text };
  }
  const [response] = await d.insert(schema.expertResponses).values({
    engagementId, answers, transcriptBlobPath, provenance: "expert_sourced",
  }).returning({ id: schema.expertResponses.id });

  // A completed call counts as answered so the honorarium can be marked paid.
  const claimed = await d.update(schema.expertEngagements).set({ status: "answered", answeredAt: new Date() })
    .where(and(eq(schema.expertEngagements.id, engagementId), eq(schema.expertEngagements.status, "invited"))).returning({ requestId: schema.expertEngagements.requestId });
  if (claimed[0]) {
    await d.update(schema.expertRequests).set({ status: "answered" })
      .where(and(eq(schema.expertRequests.id, claimed[0].requestId), eq(schema.expertRequests.status, "open")));
  }
  return { responseId: response!.id, kind: input.kind, transcriptBlobPath };
}

/**
 * Pure helpers for expert call booking (no DB, no server-only) so guardrails are unit-testable.
 * See docs/EXPERT_NETWORK.md guardrails 2, 3 and 6.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { checkEngagementToken, type TokenCheck } from "./experts-logic";

export const MIN_SLOT_LEAD_MS = 60 * 60 * 1000;
export const MAX_BULK_SLOTS = 100;
export const MAX_NOTE_CHARS = 100_000;

export const SlotInput = z.object({
  startsAt: z.iso.datetime({ offset: true }),
  durationMin: z.int().min(10).max(120).default(15),
});
export const SlotsBody = z.union([
  SlotInput.transform((s) => [s]),
  z.object({ slots: z.array(SlotInput).min(1).max(MAX_BULK_SLOTS) }).transform((b) => b.slots),
]);

export const BookBody = z.object({ slotId: z.uuid(), recordingConsent: z.boolean() });
export const NotesBody = z.object({
  text: z.string().trim().min(1).max(MAX_NOTE_CHARS),
  kind: z.enum(["notes", "transcript"]),
});

/** Jitsi Meet room: no account or auth needed. 16 hex chars of entropy make it unguessable. */
export const newMeetUrl = (): string => `https://meet.jit.si/AutonomousEvals-${randomBytes(8).toString("hex")}`;

export function slotStartError(startsAt: Date, now = new Date()): string | null {
  if (Number.isNaN(startsAt.getTime())) return "Invalid start time";
  if (startsAt.getTime() < now.getTime() + MIN_SLOT_LEAD_MS) return "Slots must start at least an hour from now";
  return null;
}

export type BookingBlock = Exclude<TokenCheck, "ok"> | "wrong_mode" | "suppressed";
/** Whether an engagement may book/reschedule/cancel a call. Suppressed or opted-out experts never can. */
export function bookingBlock(
  engagement: { status: string; expiresAt: Date; mode: string } | null | undefined,
  suppressed: boolean, now = new Date(),
): BookingBlock | null {
  const check = checkEngagementToken(engagement, now);
  if (check !== "ok") return check;
  if (suppressed) return "suppressed";
  if (engagement!.mode !== "call") return "wrong_mode";
  return null;
}

export const BOOKING_BLOCK_STATUS: Record<BookingBlock, [number, string]> = {
  not_found: [404, "This link is not valid."],
  expired: [410, "This link has expired."],
  used: [409, "This engagement is already complete."],
  cancelled: [410, "This invitation was cancelled."],
  suppressed: [410, "This invitation is no longer active."],
  wrong_mode: [409, "This engagement is not a call."],
};

export type NoteCheck = { ok: true } | { ok: false; status: number; error: string };
/** Notes are always allowed. Transcripts only when the expert explicitly consented to recording. */
export function checkNoteStorage(kind: "notes" | "transcript", recordingConsent: boolean): NoteCheck {
  if (kind === "transcript" && !recordingConsent) {
    return { ok: false, status: 409, error: "The expert did not consent to recording; store notes instead of a transcript." };
  }
  return { ok: true };
}

export const icsUid = (engagementId: string) => `${engagementId}@autonomous-evals`;

export interface CallEmailInput {
  audience: "expert" | "operator";
  expertName: string;
  domain: string;
  startsAt: Date;
  durationMin: number;
  meetUrl: string;
  recordingConsent: boolean;
  rescheduled: boolean;
  icsUrl: string;
  optOutUrl: string;
  companyAddress: string;
  engagementId: string;
}

const when = (d: Date) => d.toUTCString().replace("GMT", "UTC");

export const consentLine = (consent: boolean) =>
  consent ? "Recording: the expert consented to recording. We will ask again at the start of the call."
    : "Recording: NOT consented. The call will not be recorded; notes only.";

/** Description embedded in the .ics: AI disclosure, consent status, opt-out link. */
export function icsDescription(i: Pick<CallEmailInput, "meetUrl" | "recordingConsent" | "optOutUrl" | "domain">): string {
  return [
    `Expert call about ${i.domain} with Standard Evals.`,
    `Join: ${i.meetUrl}`,
    "Standard Evals uses AI agents. An AI agent arranged this call and prepared the questions; people at Standard Evals will run it.",
    consentLine(i.recordingConsent),
    `Cancel or opt out of future contact: ${i.optOutUrl}`,
  ].join("\n");
}

export function buildCallEmail(i: CallEmailInput): { subject: string; text: string } {
  const verb = i.rescheduled ? "rescheduled" : "confirmed";
  if (i.audience === "operator") {
    return {
      subject: `Expert call ${verb}: ${i.expertName} (${i.domain})`,
      text: [
        `Expert call ${verb}.`, "",
        `Expert: ${i.expertName}`, `Domain: ${i.domain}`, `When: ${when(i.startsAt)} (${i.durationMin} min)`,
        `Join: ${i.meetUrl}`, consentLine(i.recordingConsent), `Engagement: ${i.engagementId}`, "",
        "Calendar invite attached (.ics). After the call, add notes (or a transcript, only if recording was consented) on the engagement.",
      ].join("\n"),
    };
  }
  return {
    subject: `Your call with Standard Evals is ${verb}`,
    text: [
      `Hi ${i.expertName},`, "",
      `Your ${i.durationMin}-minute call about ${i.domain} is ${verb}.`, "",
      `When: ${when(i.startsAt)}`, `Join (no account needed): ${i.meetUrl}`, "",
      "A calendar invite is attached. You can also add it here: " + i.icsUrl, "",
      "Transparency: Standard Evals builds AI agents that evaluate other AI agents. An AI agent arranged this call and prepared the questions, and your answers become reference material labeled as expert-sourced.",
      consentLine(i.recordingConsent) + " You can change your mind at the start of the call.", "",
      `Don't want to be contacted again? Opt out here: ${i.optOutUrl}`, "",
      "Standard Evals", i.companyAddress,
    ].join("\n"),
  };
}

export function buildCancelEmail(i: { audience: "expert" | "operator"; expertName: string; domain: string; startsAt: Date; optOutUrl: string; companyAddress: string }) {
  return {
    subject: `Expert call cancelled: ${i.expertName} (${i.domain})`,
    text: [
      i.audience === "expert" ? `Hi ${i.expertName},` : "Expert call cancelled.", "",
      `The call scheduled for ${when(i.startsAt)} about ${i.domain} was cancelled.`,
      ...(i.audience === "expert" ? ["", "You can pick a new time any time from your original link.", `Opt out of future contact: ${i.optOutUrl}`, "", "Standard Evals", i.companyAddress] : []),
    ].join("\n"),
  };
}

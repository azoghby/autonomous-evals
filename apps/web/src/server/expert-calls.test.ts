import { describe, expect, it, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost/db");

import {
  BOOKING_BLOCK_STATUS, BookBody, NotesBody, SlotsBody, bookingBlock, buildCallEmail, checkNoteStorage, icsDescription,
  newMeetUrl, slotStartError,
} from "./expert-calls-logic";
import { claimSlotStatement } from "./expert-calls";

const future = new Date(Date.now() + 86_400_000);
const okEngagement = { status: "invited", expiresAt: future, mode: "call" };

describe("slot claim (race safety)", () => {
  it("is ONE conditional UPDATE ... RETURNING, so concurrent claimers serialize on the row lock", () => {
    const { sql, params } = claimSlotStatement("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222").toSQL();
    expect(sql).toMatch(/^update "call_slots" set "taken_by_engagement_id" = \$1 where \(/);
    expect(sql).toContain('"call_slots"."taken_by_engagement_id" is null');
    expect(sql).toContain('"call_slots"."starts_at" >');
    expect(sql).toMatch(/returning /);
    expect(sql).not.toMatch(/select/i);
    expect(params).toContain("22222222-2222-4222-8222-222222222222");
  });
});

describe("booking policy", () => {
  it("allows a live call engagement", () => expect(bookingBlock(okEngagement, false)).toBeNull());
  it("blocks suppressed experts (suppression respected)", () => {
    expect(bookingBlock(okEngagement, true)).toBe("suppressed");
    expect(BOOKING_BLOCK_STATUS.suppressed[0]).toBe(410);
  });
  it("blocks async, cancelled, expired, used and unknown engagements", () => {
    expect(bookingBlock({ ...okEngagement, mode: "async" }, false)).toBe("wrong_mode");
    expect(bookingBlock({ ...okEngagement, status: "cancelled" }, false)).toBe("cancelled");
    expect(bookingBlock({ ...okEngagement, expiresAt: new Date(0) }, false)).toBe("expired");
    expect(bookingBlock({ ...okEngagement, status: "answered" }, false)).toBe("used");
    expect(bookingBlock(null, false)).toBe("not_found");
  });
  it("requires an explicit boolean recording consent (no default)", () => {
    const slotId = "11111111-1111-4111-8111-111111111111";
    expect(BookBody.safeParse({ slotId }).success).toBe(false);
    expect(BookBody.safeParse({ slotId, recordingConsent: false }).success).toBe(true);
  });
});

describe("transcript consent gate", () => {
  it("refuses transcripts without recording consent", () => {
    const r = checkNoteStorage("transcript", false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
  it("allows transcripts with consent and notes always", () => {
    expect(checkNoteStorage("transcript", true).ok).toBe(true);
    expect(checkNoteStorage("notes", false).ok).toBe(true);
  });
  it("validates note bodies", () => {
    expect(NotesBody.safeParse({ text: "  ", kind: "notes" }).success).toBe(false);
    expect(NotesBody.safeParse({ text: "x", kind: "video" }).success).toBe(false);
  });
});

describe("slots input", () => {
  it("accepts a single slot or a bulk array, defaulting to 15 minutes", () => {
    const one = SlotsBody.parse({ startsAt: "2026-11-08T17:30:00Z" });
    expect(one).toEqual([{ startsAt: "2026-11-08T17:30:00Z", durationMin: 15 }]);
    expect(SlotsBody.parse({ slots: [{ startsAt: "2026-11-08T17:30:00Z", durationMin: 30 }] })).toHaveLength(1);
    expect(SlotsBody.safeParse({ slots: [] }).success).toBe(false);
  });
  it("rejects slots in the past or under an hour out", () => {
    const now = new Date("2026-11-07T12:00:00Z");
    expect(slotStartError(new Date("2026-11-07T12:30:00Z"), now)).toBeTruthy();
    expect(slotStartError(new Date("2026-11-07T14:00:00Z"), now)).toBeNull();
  });
});

describe("meet link and invite copy", () => {
  it("generates a Jitsi room with 16 hex chars", () => expect(newMeetUrl()).toMatch(/^https:\/\/meet\.jit\.si\/AutonomousEvals-[0-9a-f]{16}$/));
  const base = {
    expertName: "Dana", domain: "insurance claims", startsAt: new Date("2026-11-08T17:30:00Z"), durationMin: 15,
    meetUrl: "https://meet.jit.si/AutonomousEvals-0123456789abcdef", rescheduled: false, icsUrl: "https://x/ics",
    optOutUrl: "https://x/expert/opt-out/t", companyAddress: "1 Main St", engagementId: "e1",
  };
  it("discloses AI, consent status and the opt-out link", () => {
    const t = buildCallEmail({ ...base, audience: "expert", recordingConsent: false }).text;
    expect(t).toMatch(/AI agent/);
    expect(t).toMatch(/NOT consented/);
    expect(t).toContain(base.optOutUrl);
    expect(t).toContain(base.companyAddress);
    expect(buildCallEmail({ ...base, audience: "operator", recordingConsent: true }).text).toMatch(/consented to recording/);
  });
  it("puts the AI disclosure and opt-out in the ics description", () => {
    const d = icsDescription({ ...base, recordingConsent: true });
    expect(d).toMatch(/AI agent/);
    expect(d).toContain(base.optOutUrl);
    expect(d).toMatch(/consented/);
  });
});

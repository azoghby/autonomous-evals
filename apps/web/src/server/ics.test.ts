import { describe, expect, it } from "vitest";
import { buildIcs, foldLine, icsDate, icsEscape } from "./ics";

const ev = {
  uid: "abc@autonomous-evals", startsAt: new Date("2026-11-08T17:30:00Z"), durationMin: 15,
  summary: "Call, with; Evals", description: "Line one\nLine two; AI agent disclosure", location: "https://meet.jit.si/AutonomousEvals-0123456789abcdef",
  now: new Date("2026-11-07T12:00:00Z"), attendeeEmails: ["e@example.com"], organizerEmail: "ae@agentmail.to",
};

describe("buildIcs", () => {
  const ics = buildIcs(ev);
  const lines = ics.split("\r\n");
  it("uses CRLF only and ends with a CRLF", () => {
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });
  it("is a well-formed calendar with UTC times", () => {
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("BEGIN:VEVENT");
    expect(lines).toContain("END:VEVENT");
    expect(lines).toContain("UID:abc@autonomous-evals");
    expect(lines).toContain("DTSTAMP:20261107T120000Z");
    expect(lines).toContain("DTSTART:20261108T173000Z");
    expect(lines).toContain("DTEND:20261108T174500Z");
    expect(lines).toContain("METHOD:REQUEST");
    expect(lines.at(-2)).toBe("END:VCALENDAR");
  });
  it("escapes text and keeps lines within 75 octets", () => {
    expect(ics).toContain("SUMMARY:Call\\, with\; Evals");
    expect(ics).toContain("\\n");
    for (const l of lines) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
  });
  it("marks cancellations", () => {
    const c = buildIcs({ ...ev, method: "CANCEL" });
    expect(c).toContain("METHOD:CANCEL\r\n");
    expect(c).toContain("STATUS:CANCELLED\r\n");
  });
});

describe("helpers", () => {
  it("formats UTC dates", () => expect(icsDate(new Date("2026-01-02T03:04:05Z"))).toBe("20260102T030405Z"));
  it("escapes backslashes", () => expect(icsEscape("a\\b")).toBe("a\\\\b"));
  it("folds without splitting multibyte characters", () => {
    const folded = foldLine("X:" + "é".repeat(80));
    const parts = folded.split("\r\n");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.slice(1).every((p) => p.startsWith(" "))).toBe(true);
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join("")).toBe("X:" + "é".repeat(80));
  });
});

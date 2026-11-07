/** Minimal RFC 5545 iCalendar builder (pure, no deps). All times UTC, CRLF line endings, 75-octet folding. */

export interface IcsEvent {
  uid: string;
  startsAt: Date;
  durationMin: number;
  summary: string;
  description: string;
  location: string;
  url?: string;
  /** Monotonic revision; bump on reschedule. */
  sequence?: number;
  method?: "REQUEST" | "CANCEL";
  organizerEmail?: string;
  attendeeEmails?: string[];
  now?: Date;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** 20261107T140000Z */
export const icsDate = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;

/** TEXT value escaping per RFC 5545 section 3.3.11. */
export const icsEscape = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");

/** Fold at 75 octets (not splitting multi-byte characters); continuation lines start with a space. */
export function foldLine(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let limit = 75;
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > limit) { out.push(cur); cur = ""; limit = 74; }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function buildIcs(e: IcsEvent): string {
  const end = new Date(e.startsAt.getTime() + e.durationMin * 60_000);
  const method = e.method ?? "REQUEST";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Autonomous Evals//Expert Calls//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${icsDate(e.now ?? new Date())}`,
    `DTSTART:${icsDate(e.startsAt)}`,
    `DTEND:${icsDate(end)}`,
    `SEQUENCE:${e.sequence ?? 0}`,
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    `SUMMARY:${icsEscape(e.summary)}`,
    `DESCRIPTION:${icsEscape(e.description)}`,
    `LOCATION:${icsEscape(e.location)}`,
    ...(e.url ? [`URL:${e.url}`] : []),
    ...(e.organizerEmail ? [`ORGANIZER:mailto:${e.organizerEmail}`] : []),
    ...(e.attendeeEmails ?? []).map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT:mailto:${a}`),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

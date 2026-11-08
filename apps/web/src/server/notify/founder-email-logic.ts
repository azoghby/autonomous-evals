/** Pure helpers for email-first founder approvals: address resolution, reply parsing, anti-spoofing. Tested in founder-email-logic.test.ts. */
import type { InboundAuth } from "@ae/core/email/webhook";

type EnvLike = Record<string, string | undefined>;

/** FOUNDER_EMAIL wins; otherwise the first OPERATOR_EMAILS entry; otherwise null. Always lowercased. */
export function resolveFounderEmail(env: EnvLike = process.env): string | null {
  const explicit = env.FOUNDER_EMAIL?.trim().toLowerCase();
  if (explicit) return explicit;
  const first = (env.OPERATOR_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).find(Boolean);
  return first ?? null;
}

/** Recipients of founder emails: FOUNDER_EMAIL alone, else every operator (legacy behaviour). */
export function founderRecipients(env: EnvLike = process.env): string[] {
  const explicit = env.FOUNDER_EMAIL?.trim().toLowerCase();
  if (explicit) return [explicit];
  return [...new Set((env.OPERATOR_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Anti-spoofing on the verdicts AgentMail reports: no verdicts -> allowed (the caller still requires a thread we started);
 * any explicit failure -> refused; otherwise at least one of DMARC/DKIM/SPF must pass.
 */
export function authAllows(auth: InboundAuth | undefined): boolean {
  if (!auth) return true;
  const verdicts = [auth.spf, auth.dkim, auth.dmarc].filter((x): x is string => !!x);
  if (verdicts.length === 0) return true;
  if (verdicts.some((x) => x === "fail" || x === "softfail" || x === "permerror")) return false;
  return verdicts.some((x) => x === "pass");
}

export type FounderCommand =
  | { kind: "decide"; decision: "approve" | "reject"; seq: number | null }
  | { kind: "approve_all" }
  | { kind: "note" };

const QUOTE_HEADER = /^(on\s.+\swrote:?|-{2,}\s*(original message|forwarded message)\s*-{2,}|_{5,}|from:\s.+|sent from my .+|get outlook for .+)$/i;

/** The reply text above any quoted history or signature, trimmed. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith(">")) break;
    if (line === "--") break;
    if (QUOTE_HEADER.test(line)) break;
    // "On Mon, Nov 9, 2026 at 3:01 PM Name <a@b.c>\nwrote:" wrapped across two lines.
    if (/^on\s/i.test(line) && /wrote:?$/i.test((lines[i + 1] ?? "").trim())) break;
    kept.push(lines[i]);
  }
  return kept.join("\n").trim();
}

const APPROVE = new Set(["yes", "y", "approve", "approved", "ok", "okay", "yep", "yup", "sure", "lgtm"]);
const REJECT = new Set(["no", "n", "reject", "rejected", "nope", "deny"]);
const FILLER = new Set(["please", "pls", "thanks", "thank", "you", "thx", "ty", "go", "ahead"]);
const THUMBS_UP = /^\u{1F44D}[\u{1F3FB}-\u{1F3FF}️]*$/u;
const THUMBS_DOWN = /^\u{1F44E}[\u{1F3FB}-\u{1F3FF}️]*$/u;

/** First non-empty, non-quoted line of a reply. */
export function firstLine(text: string): string {
  return stripQuoted(text).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

/**
 * Conservative command parser for the first line only. Accepts "YES", "NO", "Approve", thumbs up/down,
 * "YES 12" / "NO #12" (number anywhere in the line), "YES ALL", with trailing filler ("yes please").
 * Anything else, including sentences that merely start with yes/no, is a note: it never triggers an action.
 */
export function parseFounderReply(text: string): FounderCommand {
  const line = firstLine(text);
  if (!line) return { kind: "note" };
  if (THUMBS_UP.test(line)) return { kind: "decide", decision: "approve", seq: null };
  if (THUMBS_DOWN.test(line)) return { kind: "decide", decision: "reject", seq: null };
  const words = line.toLowerCase().replace(/[^a-z0-9#\s]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return { kind: "note" };
  // Allow glued forms such as "yes12" / "no#12".
  const glued = /^(yes|no|y|n|approve|reject)#?(\d{1,9})$/.exec(words[0]);
  const verb = glued ? glued[1] : words[0];
  const decision = APPROVE.has(verb) ? "approve" : REJECT.has(verb) ? "reject" : null;
  if (!decision) return { kind: "note" };
  const rest = glued ? [`#${glued[2]}`, ...words.slice(1)] : words.slice(1);
  let seq: number | null = null, all = false;
  for (const w of rest) {
    const num = /^#?(\d{1,9})$/.exec(w);
    if (num && seq === null) seq = Number(num[1]);
    else if (w === "all" && !all) all = true;
    else if (!FILLER.has(w)) return { kind: "note" };
  }
  if (all) return decision === "approve" && seq === null ? { kind: "approve_all" } : { kind: "note" };
  return { kind: "decide", decision, seq };
}

/** "[Approve #12] Title" -> 12. */
export function seqFromSubject(subject: string): number | null {
  const m = /#(\d{1,9})\b/.exec(subject ?? "");
  return m ? Number(m[1]) : null;
}

export const FOUNDER_HELP = "I did not recognise that as a command, so I saved it as a note (no action taken). To decide, reply with YES or NO (or YES 12 / NO 12). YES ALL approves every pending outreach draft.";

export const MAX_NOTE_CHARS = 4000;
export const boundNote = (text: string) => stripQuoted(text).slice(0, MAX_NOTE_CHARS);

export interface FounderNote { id: string; body: string; createdAt: Date; approvalSeq: number | null }

/** Section appended to the daily report for notes received since the last one. */
export function formatNotesSection(notes: FounderNote[]): string {
  if (notes.length === 0) return "";
  const lines = notes.slice(0, 10).map((n) => `- ${n.approvalSeq !== null ? `(re #${n.approvalSeq}) ` : ""}${n.body.replace(/\s+/g, " ").slice(0, 300)}`);
  return ["", `Your notes since the last report (saved, not acted on): ${notes.length}`, ...lines, ...(notes.length > 10 ? [`...and ${notes.length - 10} more in /operator`] : [])].join("\n");
}

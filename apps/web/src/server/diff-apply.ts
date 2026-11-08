/**
 * Small, strict unified-diff applier. Pure (no I/O). Fails with a reason instead of guessing:
 * every context/removed line must match the file exactly (hunks may drift by line offset).
 */
export type ApplyResult = { ok: true; content: string } | { ok: false; error: string };

interface Hunk {
  oldStart: number;
  oldCount: number;
  newCount: number;
  old: string[];
  next: string[];
  newNoEol: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
export const MAX_DIFF_FILE_BYTES = 1_000_000;

/** True when the text contains at least one unified-diff hunk header. */
export const looksLikeUnifiedDiff = (text: string): boolean => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text);

function parseHunks(diff: string): Hunk[] | string {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < lines.length && !HUNK_HEADER.test(lines[i]!)) i++; // skip diff --git / index / ---/+++ headers
  while (i < lines.length) {
    const m = HUNK_HEADER.exec(lines[i]!);
    if (!m) return `unexpected line outside a hunk: "${lines[i]!.slice(0, 60)}"`;
    const h: Hunk = {
      oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newCount: m[4] === undefined ? 1 : Number(m[4]), old: [], next: [], newNoEol: false,
    };
    i++;
    let prev = "";
    while (i < lines.length && (h.old.length < h.oldCount || h.next.length < h.newCount || lines[i]!.startsWith("\\"))) {
      const line = lines[i]!;
      const tag = line === "" ? " " : line[0]!;
      const text = line.slice(1);
      if (tag === "\\") { if (prev === "+" || prev === " ") h.newNoEol = true; }
      else if (tag === " ") { h.old.push(text); h.next.push(text); }
      else if (tag === "-") h.old.push(text);
      else if (tag === "+") h.next.push(text);
      else return `invalid hunk line: "${line.slice(0, 60)}"`;
      if (tag !== "\\") prev = tag;
      i++;
    }
    if (h.old.length !== h.oldCount || h.next.length !== h.newCount) return `hunk @@ -${h.oldStart} line counts do not match its header`;
    hunks.push(h);
    while (i < lines.length && lines[i]!.startsWith("\\")) i++;
  }
  return hunks.length ? hunks : "diff contains no hunks";
}

const matchesAt = (file: string[], at: number, old: string[]) =>
  at >= 0 && at + old.length <= file.length && old.every((l, k) => file[at + k] === l);

/** Nearest exact match of `old` to `want`, not before `min`. -1 when none. */
function locate(file: string[], old: string[], want: number, min: number): number {
  if (old.length === 0) return Math.min(Math.max(want, min), file.length);
  for (let d = 0; d <= file.length; d++) {
    for (const at of d === 0 ? [want] : [want - d, want + d]) if (at >= min && matchesAt(file, at, old)) return at;
  }
  return -1;
}

export function applyUnifiedDiff(content: string, diff: string): ApplyResult {
  if (Buffer.byteLength(content) > MAX_DIFF_FILE_BYTES) return { ok: false, error: "file is too large to patch" };
  const parsed = parseHunks(diff);
  if (typeof parsed === "string") return { ok: false, error: `malformed diff: ${parsed}` };

  const crlf = content.includes("\r\n");
  const text = crlf ? content.replace(/\r\n/g, "\n") : content;
  let endsWithNewline = text.endsWith("\n") || text === "";
  const file = text === "" ? [] : text.split("\n");
  if (text.endsWith("\n")) file.pop();

  let cursor = 0;
  let delta = 0;
  for (const [n, h] of parsed.entries()) {
    const want = (h.oldCount === 0 ? h.oldStart : h.oldStart - 1) + delta;
    const at = locate(file, h.old, want, cursor);
    if (at < 0) return { ok: false, error: `hunk ${n + 1} (@@ -${h.oldStart}) does not match the current file contents` };
    file.splice(at, h.old.length, ...h.next);
    delta += at - want + h.next.length - h.old.length;
    cursor = at + h.next.length;
    if (at + h.next.length === file.length) endsWithNewline = !h.newNoEol;
  }
  const joined = file.join("\n") + (endsWithNewline && file.length > 0 ? "\n" : "");
  return { ok: true, content: crlf ? joined.replace(/\n/g, "\r\n") : joined };
}

/**
 * Objective (code) checks for Text Eval (PLAN.md §4.2). Pure and deterministic: the same check and
 * response always produce the same CheckResult, and no input makes this module throw.
 *
 * Status meaning here:
 * - pass / fail: the check ran on the response and the response met / did not meet the spec.
 * - error (reason "check_error"): the check itself could not run (malformed spec, oversize regex
 *   input). That is a test defect, never a customer failure.
 *
 * Evidence quotes are always verbatim substrings of the ORIGINAL response text. Matching happens
 * on a prepared copy (CRLF -> LF, optionally lowercased per code point) that keeps, for every code
 * unit, the original range it came from, so matches map back exactly even when lowercasing
 * changes length (e.g. "İ" -> "i̇").
 */
import {
  type CheckResult,
  MAX_EVIDENCE_QUOTE_CHARS,
  type ObjectiveCheck,
  type ObjectiveEvaluator,
  type ObjectiveSpec,
  ObjectiveSpecSchema,
} from "./schema";

/** Regexes never run on more than this many UTF-16 units; larger input is an error, never truncated. */
export const MAX_REGEX_INPUT_CHARS = 100_000;
const MAX_ECHO_CHARS = 120;
const CONTEXT_CHARS = 60;
const MAX_QUOTES = 6;
const MAX_OCCURRENCE_QUOTES = 3;
const MAX_COUNTED_MATCHES = 1_000;

type Outcome = Pick<CheckResult, "status" | "detail" | "evidenceQuotes">;

export function evaluateObjectiveCheck(check: ObjectiveCheck, responseText: string): CheckResult {
  const checkId = typeof (check as unknown as { id?: unknown } | null)?.id === "string" ? check.id : "";
  try {
    if (typeof responseText !== "string") return errorResult(checkId, "check could not run: response text is not a string");
    const parsed = ObjectiveSpecSchema.safeParse((check as unknown as { spec?: unknown } | null)?.spec);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message));
      return errorResult(checkId, `invalid objective spec (test defect): ${clip(issues.join("; "), 300)}`);
    }
    const outcome = evaluateSpec(parsed.data, responseText);
    if (outcome.status === "error") return errorResult(checkId, outcome.detail);
    return {
      checkId,
      kind: "objective",
      status: outcome.status,
      detail: outcome.detail,
      evidenceQuotes: outcome.evidenceQuotes.filter((q) => q.length > 0).slice(0, MAX_QUOTES),
      reason: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResult(checkId, `check could not run: ${clip(message, MAX_ECHO_CHARS)}`);
  }
}

export const evaluateObjective: ObjectiveEvaluator = evaluateObjectiveCheck;

function errorResult(checkId: string, detail: string): CheckResult {
  return { checkId, kind: "objective", status: "error", detail, evidenceQuotes: [], reason: "check_error" };
}

function evaluateSpec(spec: ObjectiveSpec, text: string): Outcome | { status: "error"; detail: string; evidenceQuotes: string[] } {
  switch (spec.type) {
    case "contains": {
      const hay = prepare(text, !spec.case_sensitive);
      const hit = findAll(hay, prepare(spec.value, !spec.case_sensitive).s, 1).ranges[0];
      if (!hit) return { status: "fail", detail: `required text ${echo(spec.value)} not found`, evidenceQuotes: [] };
      return { status: "pass", detail: `found required text ${echo(spec.value)}`, evidenceQuotes: [quoteRange(text, hit, 0)] };
    }
    case "not_contains": {
      const hay = prepare(text, !spec.case_sensitive);
      const { ranges, count } = findAll(hay, prepare(spec.value, !spec.case_sensitive).s, MAX_OCCURRENCE_QUOTES);
      if (count === 0) return { status: "pass", detail: `forbidden text ${echo(spec.value)} not found`, evidenceQuotes: [] };
      return {
        status: "fail",
        detail: `found forbidden text ${echo(spec.value)} (${countLabel(count, "occurrence")})`,
        evidenceQuotes: ranges.map((r) => quoteRange(text, r, CONTEXT_CHARS)),
      };
    }
    case "contains_any": {
      const hay = prepare(text, !spec.case_sensitive);
      const found: string[] = [];
      const quotes: string[] = [];
      for (const value of spec.values) {
        const hit = findAll(hay, prepare(value, !spec.case_sensitive).s, 1).ranges[0];
        if (!hit) continue;
        found.push(value);
        const q = quoteRange(text, hit, 0);
        if (!quotes.includes(q)) quotes.push(q);
      }
      if (found.length === 0) {
        return { status: "fail", detail: `none of the accepted texts found: ${spec.values.map(echo).join(", ")}`, evidenceQuotes: [] };
      }
      const first = found[0] ?? "";
      const extra = found.length > 1 ? ` (${found.length} of ${spec.values.length} accepted texts found)` : "";
      return { status: "pass", detail: `found accepted text ${echo(first)}${extra}`, evidenceQuotes: quotes };
    }
    case "regex_match":
    case "regex_absent":
      return { status: "error", detail: "regex checks are unsupported; revise the test using literal checks", evidenceQuotes: [] };
    case "max_chars": {
      const n = [...text].length;
      return { status: n <= spec.value ? "pass" : "fail", detail: `${n} characters; limit ${spec.value}`, evidenceQuotes: [] };
    }
    case "min_chars": {
      const n = [...text].length;
      return { status: n >= spec.value ? "pass" : "fail", detail: `${n} characters; minimum ${spec.value}`, evidenceQuotes: [] };
    }
    case "max_words": {
      const n = text.trim().split(/\s+/).filter((w) => w.length > 0).length;
      return { status: n <= spec.value ? "pass" : "fail", detail: `${n} words; limit ${spec.value}`, evidenceQuotes: [] };
    }
    case "max_lines": {
      const lines = text.split(/\r\n|\r|\n/);
      // A final newline terminates the last line rather than starting a new one.
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const n = lines.length;
      return { status: n <= spec.value ? "pass" : "fail", detail: `${n} lines; limit ${spec.value}`, evidenceQuotes: [] };
    }
    case "json_valid": {
      const r = extractJson(text);
      if (!r.ok) return { status: "fail", detail: r.detail, evidenceQuotes: [] };
      return { status: "pass", detail: r.fenced ? "response is one fenced code block containing valid JSON" : "response is valid JSON", evidenceQuotes: [] };
    }
    case "json_has_keys": {
      const r = extractJson(text);
      if (!r.ok) return { status: "fail", detail: r.detail, evidenceQuotes: [] };
      const v = r.value;
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        const kind = v === null ? "null" : Array.isArray(v) ? "an array" : `a ${typeof v}`;
        return { status: "fail", detail: `JSON value is ${kind}, not an object`, evidenceQuotes: [] };
      }
      const missing = spec.keys.filter((k) => !Object.prototype.hasOwnProperty.call(v, k));
      if (missing.length > 0) return { status: "fail", detail: `missing top-level keys: ${missing.map(echo).join(", ")}`, evidenceQuotes: [] };
      return { status: "pass", detail: `JSON object has all ${spec.keys.length} required keys`, evidenceQuotes: [] };
    }
  }
}

// ---------------------------------------------------------------------------
// Prepared text with exact index mapping back to the original
// ---------------------------------------------------------------------------

interface Prepared {
  /** Matching copy: CRLF -> LF, optionally lowercased per code point. */
  s: string;
  /** For each code unit of `s`: start / end (exclusive) of the source range in the original. */
  start: number[];
  end: number[];
  originalLength: number;
}

interface Range {
  start: number;
  end: number;
}

/** Lowercase one code point without locale; final sigma folds to sigma so "ΟΔΟΣ" finds "οδος". */
function foldChar(ch: string): string {
  const lower = ch.toLowerCase();
  return lower === "ς" ? "σ" : lower;
}

function prepare(text: string, fold: boolean): Prepared {
  const parts: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) ?? 0;
    let srcEnd = i + (cp > 0xffff ? 2 : 1);
    let unit: string;
    if (cp === 13 && text.charCodeAt(i + 1) === 10) {
      unit = "\n";
      srcEnd = i + 2;
    } else {
      const ch = text.slice(i, srcEnd);
      unit = fold ? foldChar(ch) : ch;
    }
    for (let k = 0; k < unit.length; k++) {
      start.push(i);
      end.push(srcEnd);
    }
    parts.push(unit);
    i = srcEnd;
  }
  return { s: parts.join(""), start, end, originalLength: text.length };
}

/** Maps a [a, b) match in the prepared copy to the smallest covering range of the original. */
function toOriginal(p: Prepared, a: number, b: number): Range {
  if (b <= a) {
    const at = a < p.start.length ? (p.start[a] ?? p.originalLength) : p.originalLength;
    return { start: at, end: at };
  }
  return { start: p.start[a] ?? p.originalLength, end: p.end[b - 1] ?? p.originalLength };
}

/** Non-overlapping occurrences; returns the first `keep` ranges and a total count (capped). */
function findAll(p: Prepared, needle: string, keep: number): { ranges: Range[]; count: number } {
  const ranges: Range[] = [];
  let count = 0;
  if (needle.length === 0) return { ranges, count };
  let from = 0;
  while (count < MAX_COUNTED_MATCHES) {
    const idx = p.s.indexOf(needle, from);
    if (idx < 0) break;
    count++;
    if (ranges.length < keep) ranges.push(toOriginal(p, idx, idx + needle.length));
    from = idx + needle.length;
  }
  return { ranges, count };
}

// ---------------------------------------------------------------------------
// Verbatim quotes
// ---------------------------------------------------------------------------

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
/** True when index `i` sits between the two halves of a surrogate pair. */
const splitsPair = (t: string, i: number) => i > 0 && i < t.length && isLow(t.charCodeAt(i)) && isHigh(t.charCodeAt(i - 1));

/**
 * Verbatim slice of `text` covering `r` plus up to `context` units each side, at most
 * MAX_EVIDENCE_QUOTE_CHARS long, never splitting a surrogate pair.
 */
function quoteRange(text: string, r: Range, context: number): string {
  let s = Math.max(0, r.start - context);
  let e = Math.min(text.length, r.end + context);
  if (e - s > MAX_EVIDENCE_QUOTE_CHARS) {
    const matchLen = r.end - r.start;
    if (matchLen >= MAX_EVIDENCE_QUOTE_CHARS) {
      s = r.start;
    } else {
      const spare = MAX_EVIDENCE_QUOTE_CHARS - matchLen;
      s = Math.max(s, r.start - Math.floor(spare / 2));
    }
    e = Math.min(e, s + MAX_EVIDENCE_QUOTE_CHARS);
    if (splitsPair(text, e)) e--;
  } else if (splitsPair(text, e)) {
    e = e + 1 - s <= MAX_EVIDENCE_QUOTE_CHARS ? e + 1 : e - 1;
  }
  if (splitsPair(text, s)) s = s < r.start ? s + 1 : s;
  return text.slice(s, e);
}

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

/**
 * The trimmed response must be JSON. We ALSO accept a response that is exactly one fenced code
 * block (```json ... ``` or ``` ... ```, nothing outside it) and parse its body, because models
 * routinely wrap JSON that way and the customer's consumer typically strips the fence. Any other
 * prose around the JSON fails.
 */
const FENCE = /^```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i;

function extractJson(text: string): { ok: true; value: unknown; fenced: boolean } | { ok: false; detail: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, detail: "response is empty, not JSON" };
  const direct = tryParse(trimmed);
  if (direct.ok) return { ok: true, value: direct.value, fenced: false };
  const m = FENCE.exec(trimmed);
  const body = m?.[1];
  if (body !== undefined && !body.includes("```")) {
    const inner = tryParse(body.trim());
    if (inner.ok) return { ok: true, value: inner.value, fenced: true };
    return { ok: false, detail: `fenced code block is not valid JSON (${clip(inner.message, MAX_ECHO_CHARS)})` };
  }
  return { ok: false, detail: `response is not valid JSON (${clip(direct.message, MAX_ECHO_CHARS)})` };
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(s) as unknown };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "parse error" };
  }
}

// ---------------------------------------------------------------------------
// Detail helpers
// ---------------------------------------------------------------------------

function clip(value: string, max: number): string {
  const cps = [...value];
  return cps.length <= max ? value : `${cps.slice(0, max).join("")}…`;
}

/** Quoted, escaped, clipped echo of a spec value. */
function echo(value: string): string {
  return JSON.stringify(clip(value, MAX_ECHO_CHARS));
}

function countLabel(n: number, one: string, many = `${one}s`): string {
  const shown = n >= MAX_COUNTED_MATCHES ? `${MAX_COUNTED_MATCHES}+` : String(n);
  return `${shown} ${n === 1 ? one : many}`;
}

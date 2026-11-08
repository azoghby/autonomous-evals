/**
 * Value matching shared by the media oracle and perception graders.
 * Ground-truth values are short facts ("47.20", "ORD-88412", "jane@acme.test"); a read/heard value matches if,
 * after normalization, it equals or contains the expected value, or both parse to the same number.
 */

/** Lowercase, drop currency symbols/thousands separators, collapse whitespace, strip surrounding punctuation. */
export function normalizeValue(v: string): string {
  return v
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[$€£¥]|usd|eur|gbp/g, "")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/[“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s.,;:!?()[\]{}-]+|[\s.,;:!?()[\]{}]+$/g, "");
}

/** Loose form for spoken/OCR'd identifiers: drop all non-alphanumerics except the decimal point between digits. */
export function compactValue(v: string): string {
  return normalizeValue(v).replace(/(?<!\d)\.|\.(?!\d)/g, "").replace(/[^a-z0-9.@]/g, "");
}

function asNumber(v: string): number | undefined {
  const s = normalizeValue(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return undefined;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

/** True if `observed` (a single read value) matches `expected`. */
export function valuesMatch(expected: string, observed: string | null | undefined): boolean {
  if (observed == null) return false;
  const e = normalizeValue(expected);
  const o = normalizeValue(observed);
  if (!e) return false;
  if (e === o) return true;
  const ne = asNumber(expected);
  const no = asNumber(observed);
  if (ne !== undefined && no !== undefined) return Math.abs(ne - no) < 1e-9;
  const ce = compactValue(expected);
  return ce.length > 0 && compactValue(observed) === ce;
}

/**
 * True if `expected` occurs somewhere inside free text (a transcript, a reply, JSON-encoded tool args).
 * Numbers match on numeric value at token boundaries ("47.2" finds "47.20"); other values match on the compact form.
 */
export function textContainsValue(text: string, expected: string): boolean {
  const ne = asNumber(expected);
  if (ne !== undefined) {
    const nums = normalizeValue(text).match(/-?\d+(?:\.\d+)?/g) ?? [];
    return nums.some((n) => Math.abs(Number.parseFloat(n) - ne) < 1e-9);
  }
  const ce = compactValue(expected);
  if (!ce) return false;
  return compactValue(text).includes(ce) || normalizeValue(text).includes(normalizeValue(expected));
}

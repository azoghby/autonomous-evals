/** Pure, PII-safe projection of an activity row for the public /company page. No I/O. */

export interface PublicActivityRow {
  agentId: string;
  status: string;
  startedAt: Date | string;
  publicSummary?: string | null;
  counts?: Record<string, unknown> | null;
  // Full rows also carry summary/detail; they are deliberately never copied.
  [extra: string]: unknown;
}

export interface PublicLatest { at: string; status: string; publicSummary: string | null }
export interface PublicActivity extends PublicLatest { agentId: string; counts: Record<string, number> }

const EMAIL = /[^\s<>()"',;]+@[^\s<>()"',;]+/g;
const URL_LIKE = /(?:https?:\/\/|www\.)[^\s<>()"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|ai|co|dev|app|xyz|gg|so)\b(?:\/[^\s<>()"']*)?/gi;
const MAX_PUBLIC_TEXT = 240;
const SAFE_KEY = /^[a-z][a-z0-9_]{0,39}$/i;

/** Defensive scrub: remove email- and URL-looking substrings, collapse whitespace, cap length. */
export function sanitizePublicText(text: string | null | undefined): string | null {
  if (!text) return null;
  const cleaned = text.replace(EMAIL, "").replace(URL_LIKE, "").replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_PUBLIC_TEXT ? `${cleaned.slice(0, MAX_PUBLIC_TEXT - 1).trimEnd()}…` : cleaned;
}

/** Keep only finite numeric values under identifier-like keys. */
export function sanitizeCounts(counts: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts ?? {})) {
    if (SAFE_KEY.test(k) && typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Whitelist: agentId, status, time, sanitized publicSummary, numeric counts. Never summary/detail. */
export function toPublicActivity(row: PublicActivityRow): PublicActivity {
  return {
    agentId: row.agentId,
    status: row.status,
    at: (row.startedAt instanceof Date ? row.startedAt : new Date(row.startedAt)).toISOString(),
    publicSummary: sanitizePublicText(row.publicSummary),
    counts: sanitizeCounts(row.counts),
  };
}

import { redactSecretPatterns } from "@/workflows/decisions";
import { hashToken, newToken } from "@ae/core/auth/tokens";
import type { Finding, Remediation } from "@ae/core/contracts/index";

/* ---------- tokens ---------- */

export interface NewShareToken { token: string; tokenHash: string }

/** Fresh random share token. Only `tokenHash` is persisted; `token` is returned to the owner exactly once. */
export function generateShareToken(): NewShareToken {
  const token = newToken();
  return { token, tokenHash: hashToken(token) };
}

/** Shape check before touching the DB (43-char base64url from newToken). */
export const isPlausibleShareToken = (t: string) => /^[A-Za-z0-9_-]{32,64}$/.test(t);

/* ---------- redaction ---------- */

type Severity = Finding["severity"];
export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low"];

export interface FindingRowInput { id: string; data: unknown }
export interface RemediationRowInput { findingRowId: string; data: unknown }
export interface ShareJobInput { package: string; deliveredAt: Date | null; isMock: boolean; environment: string }

export interface RedactedFinding {
  title: string; category: string; severity: Severity;
  fix: null | {
    summary: string; kind: string;
    verification: "verified" | "partially_verified" | "not_verified";
    before: { passed: number; total: number }; after: { passed: number; total: number };
  };
  isOpen: boolean;
}

export interface RedactedReport {
  package: string;
  deliveredAt: string | null;
  isSample: boolean;
  counts: Record<Severity, number>;
  total: number;
  fixedCount: number;
  openCounts: Record<Severity, number>;
  findings: RedactedFinding[];
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s)>\]"']+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
/** Dotted hostnames ending in a TLD-ish or internal suffix, with optional port/path. */
const HOST_RE = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app|co|cloud|internal|local|lan|corp|intranet|svc|test|example)\b(?::\d{1,5})?(?:\/\S*)?/gi;
/** Long opaque tokens (hex / base64-ish / ids) of 24+ chars containing a digit. */
const OPAQUE_RE = /\b(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]{24,}\b/g;
export const SCRUBBED_MAX_CHARS = 160;
/** Strip anything that could identify the customer's endpoints, people or credentials from free text. */
export function scrubText(s: string): string {
  const out = redactSecretPatterns(s)
    .replace(URL_RE, "[link removed]")
    .replace(EMAIL_RE, "[email removed]")
    .replace(IPV4_RE, "[host removed]")
    .replace(HOST_RE, "[host removed]")
    .replace(OPAQUE_RE, "[redacted]")
    .replace(/\s+/g, " ").trim();
  return out.length > SCRUBBED_MAX_CHARS ? `${out.slice(0, SCRUBBED_MAX_CHARS - 3)}...` : out;
}

const zeroCounts = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, low: 0 });
const isSeverity = (v: unknown): v is Severity => typeof v === "string" && (SEVERITY_ORDER as readonly string[]).includes(v);
const pass = (v: unknown) => {
  const o = (v ?? {}) as { passed?: unknown; total?: unknown };
  return { passed: Number(o.passed) || 0, total: Number(o.total) || 0 };
};

/**
 * Whitelist-build the public view. Nothing is copied wholesale from a row: every output field is
 * picked explicitly, so evidence, endpoints, prompts/patches and customer identity can never leak.
 */
export function redactReport(job: ShareJobInput, findingRows: FindingRowInput[], remediationRows: RemediationRowInput[]): RedactedReport {
  const fixByFinding = new Map<string, Remediation>();
  for (const r of remediationRows) fixByFinding.set(r.findingRowId, r.data as Remediation);

  const counts = zeroCounts();
  const openCounts = zeroCounts();
  const findings: RedactedFinding[] = [];
  let fixedCount = 0;

  for (const row of findingRows) {
    const d = (row.data ?? {}) as Partial<Finding>;
    if (d.status !== "confirmed" || !isSeverity(d.severity)) continue;
    const rem = fixByFinding.get(row.id);
    const v = rem?.verification;
    const verified = v?.status === "verified";
    counts[d.severity] += 1;
    if (verified) fixedCount += 1; else openCounts[d.severity] += 1;
    findings.push({
      title: scrubText(String(d.title ?? "Untitled finding")),
      category: String(d.category ?? "other"),
      severity: d.severity,
      isOpen: !verified,
      fix: rem && v ? {
        summary: scrubText(String(rem.summary ?? "")),
        kind: String(rem.kind ?? "other"),
        verification: v.status,
        before: pass(v.before),
        after: pass(v.after),
      } : null,
    });
  }
  findings.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));

  return {
    package: job.package,
    deliveredAt: job.deliveredAt ? job.deliveredAt.toISOString() : null,
    isSample: job.isMock || job.environment !== "live",
    counts, total: findings.length, fixedCount, openCounts, findings,
  };
}

/* ---------- badge ---------- */

export const BADGE_COLORS = { blue: "#2F6BFF", amber: "#D9A400", orange: "#E8590C", red: "#E5484D", label: "#0A0A0B" } as const;

/** Worst open severity decides the colour. Blue = no open high/critical (low/medium open still reads as "clean enough"). */
export function badgeColor(openCounts: Record<Severity, number>): string {
  if (openCounts.critical > 0) return BADGE_COLORS.red;
  if (openCounts.high > 0) return BADGE_COLORS.orange;
  return BADGE_COLORS.blue;
}

export const badgeMessage = (r: Pick<RedactedReport, "openCounts" | "fixedCount">) =>
  `${r.openCounts.critical} critical · ${r.fixedCount} fixed`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const textWidth = (s: string) => Math.ceil(s.length * 6.4) + 14; // Verdana 11px approximation

/** Shields-style flat badge. Pure string output. */
export function renderBadgeSvg(label: string, message: string, color: string): string {
  const lw = textWidth(label), mw = textWidth(message), w = lw + mw;
  const l = esc(label), m = esc(message);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${l}: ${m}">` +
    `<title>${l}: ${m}</title>` +
    `<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
    `<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="${BADGE_COLORS.label}"/><rect x="${lw}" width="${mw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s)"/></g>` +
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${lw / 2}" y="14">${l}</text><text x="${lw + mw / 2}" y="14">${m}</text></g></svg>`;
}

export const invalidBadgeSvg = () => renderBadgeSvg("Standard Evals", "unavailable", "#6B7280");

/* ---------- urls / snippet ---------- */

export function shareUrls(baseUrl: string, token: string) {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}/r/${token}`;
  const badgeUrl = `${url}/badge.svg`;
  return { url, badgeUrl, markdown: `[![Standard Evals](${badgeUrl})](${url})` };
}

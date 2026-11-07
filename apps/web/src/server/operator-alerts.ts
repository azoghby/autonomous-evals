import "server-only";
import { isEmailConfigured, sendEmail } from "@ae/core/auth/email";
import { operatorEmails } from "@ae/core/auth/tokens";
import { rateLimit } from "./rate-limit";

export type OperatorAlertSeverity = "info" | "warning" | "critical";

export interface OperatorAlert {
  /** Stable machine kind, e.g. "job_failed", "payment_review". Part of the dedupe key. */
  kind: string;
  jobId?: string;
  title: string;
  /** Short reason only: job state / one-line cause. Never trace content or credentials (redacted + truncated here as a backstop). */
  detail: string;
  severity: OperatorAlertSeverity;
}

export const ALERT_DEDUPE_SECONDS = 6 * 60 * 60;
const MAX_DETAIL_CHARS = 240;
const MAX_TITLE_CHARS = 120;

const appUrl = () => (process.env.APP_URL ?? "https://autonomous-evals.vercel.app").replace(/\/$/, "");
const operatorUrl = () => `${appUrl()}/operator`;

/** Redacts anything credential-shaped, collapses whitespace and truncates. Defense in depth for free-text reasons. */
export function redactAlertText(input: string, max = MAX_DETAIL_CHARS): string {
  const out = input
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@\S+/gi, "[redacted-url]")
    .replace(/\b(sk|pk|rk|whsec|key|tok|token|secret)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/\b(api[-_ ]?key|authorization|x-api-key|password|passwd|secret|token|cookie)\s*[:=]\s*\S+/gi, "$1: [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]")
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted]")
    .replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildAlertEmail(alert: OperatorAlert): { subject: string; text: string; html: string } {
  const title = redactAlertText(alert.title, MAX_TITLE_CHARS);
  const detail = redactAlertText(alert.detail);
  const kind = redactAlertText(alert.kind, 60);
  const link = operatorUrl();
  const subject = `[${alert.severity.toUpperCase()}] ${title}${alert.jobId ? ` (job ${alert.jobId.slice(0, 8)})` : ""}`;
  const lines = [title, "", `Kind: ${kind}`, ...(alert.jobId ? [`Job: ${alert.jobId}`] : []), `Severity: ${alert.severity}`, `Detail: ${detail}`, "", `Review in the operator console: ${link}`];
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
<h2 style="margin:0 0 12px">${escapeHtml(title)}</h2>
<table style="border-collapse:collapse;font-size:14px">
<tr><td style="padding:2px 12px 2px 0;color:#666">Kind</td><td>${escapeHtml(kind)}</td></tr>
${alert.jobId ? `<tr><td style="padding:2px 12px 2px 0;color:#666">Job</td><td><code>${escapeHtml(alert.jobId)}</code></td></tr>` : ""}
<tr><td style="padding:2px 12px 2px 0;color:#666">Severity</td><td>${escapeHtml(alert.severity)}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:#666">Detail</td><td>${escapeHtml(detail)}</td></tr>
</table>
<p style="margin-top:16px"><a href="${escapeHtml(link)}">Open the operator console</a></p>
</div>`;
  return { subject, text: lines.join("\n"), html };
}

/**
 * Emails every operator (OPERATOR_EMAILS) about something needing a human. Deduplicated: the same
 * (kind, jobId) alerts at most once per 6h (rate_limits counter, fails open). Never throws.
 * Returns true when at least one email was sent.
 */
export async function alertOperators(alert: OperatorAlert): Promise<boolean> {
  try {
    const recipients = [...operatorEmails()];
    if (recipients.length === 0) { console.error("operator alert skipped: OPERATOR_EMAILS is empty", alert.kind, alert.jobId ?? "-"); return false; }
    if (!isEmailConfigured()) { console.error("operator alert skipped: email not configured", alert.kind, alert.jobId ?? "-"); return false; }
    const gate = await rateLimit(`operator-alert:${alert.kind}:${alert.jobId ?? "-"}`, 1, ALERT_DEDUPE_SECONDS);
    if (!gate.ok) return false;
    const { subject, text, html } = buildAlertEmail(alert);
    const results = await Promise.allSettled(recipients.map((to) => sendEmail({ to, subject, text, html, purpose: "auth", labels: ["operator-alert"] })));
    let sent = 0;
    for (const r of results) {
      if (r.status === "fulfilled") sent++;
      else console.error("operator alert send failed", alert.kind, alert.jobId ?? "-", r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
    return sent > 0;
  } catch (err) {
    console.error("operator alert failed", alert.kind, alert.jobId ?? "-", err instanceof Error ? err.message : String(err));
    return false;
  }
}

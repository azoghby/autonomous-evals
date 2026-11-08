/**
 * Base URL for links that leave the app in emails (outreach, unsubscribe, approvals, expert invites).
 * Always the public production site: never a request host, never localhost. APP_URL wins only when it is a
 * public https URL. Drafts generated from a laptop script (no APP_URL) used to get http://localhost:3000 links.
 */
export const PRODUCTION_APP_URL = "https://standard-evals.vercel.app";

const LOCAL_RE = /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])/i;

/** True when text contains a local / loopback URL host. */
export const containsLocalUrl = (s: string): boolean => LOCAL_RE.test(s);

export function publicAppUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.APP_URL ?? "").trim().replace(/\/+$/, "");
  return raw.startsWith("https://") && !containsLocalUrl(raw) ? raw : PRODUCTION_APP_URL;
}

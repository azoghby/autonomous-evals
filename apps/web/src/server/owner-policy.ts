/**
 * Agent-owner autopilot: pure policy shared by submission, lifecycle emails, the reply responder and outreach.
 * No DB, no "server-only": everything here is unit-testable.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// ---- data-model contract (public_agents columns added in migration 0015) ----------------------

export const OWNER_STATUSES = ["pending_verification", "active", "paused", "opted_out"] as const;
export type OwnerStatus = (typeof OWNER_STATUSES)[number];
export const VISIBILITIES = ["public", "private"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/**
 * authEnvVar value stored on owner-submitted agents that carry an encrypted key (api_key_ciphertext).
 * The env var is never set, so the generic env-var runner refuses these rows ("env var ... is not set") instead of
 * running them keyless. Owner agents run through owner-runner.ts, which decrypts the key.
 */
export const OWNER_KEY_SENTINEL = "OWNER_SUBMITTED_KEY";

/** https URL recorded as termsUrl once an owner verifies (assertAuthorizedToTest requires https). */
export const OWNER_TERMS_URL = "https://autonomous-evals.vercel.app/leaderboard/submit#consent";

export const CONSENT_VERSION = "owner-consent-v1";
export const CONSENT_AUTHORIZE_TEXT =
  "I own this agent or am authorized to test it, including adversarial red-team prompts.";
export const CONSENT_EMAILS_TEXT =
  "I agree to automated emails about this agent from Standard Evals' agents (unsubscribe anytime).";

export interface ConsentRecord {
  version: string; authorizeText: string; emailsText: string; acceptedAt: string; ipHash: string;
}

/** Status -> runner gate. Only "active" agents are eligible for runs. */
export const isRunnable = (status: string) => status === "active";

// ---- sender identity and footer ---------------------------------------------------------------

export const SENDER_LINE = "Sent by Standard Evals' agents. This email was written and sent automatically by our AI agents.";

export function ownerFooter(i: { agentName: string; unsubscribeUrl: string; companyAddress: string }): string {
  return [
    "--",
    SENDER_LINE,
    `You get this because you submitted "${i.agentName}" for testing and agreed to automated emails about it.`,
    `Unsubscribe from all non-essential emails in one click: ${i.unsubscribeUrl}`,
    "Reply to this email to ask a question, pause runs, make results private, or opt out.",
    i.companyAddress,
  ].join("\n");
}

// ---- cadence ----------------------------------------------------------------------------------

/** Max one non-transactional email per owner per 3 days. */
export const NON_TRANSACTIONAL_GAP_MS = 3 * 24 * 60 * 60 * 1000;
export const FIX_OFFER_DELAY_MS = 24 * 60 * 60 * 1000;
export const WEEKLY_RUN_MS = 7 * 24 * 60 * 60 * 1000;
/** Owner-requested re-runs: at most one per agent per day. */
export const OWNER_RERUN_MIN_GAP_MS = 24 * 60 * 60 * 1000;
/** Score change (percentage points) that makes a re-run worth emailing about. */
export const RERUN_NOTIFY_DELTA_PTS = 5;

export function canSendNonTransactional(lastNonTransactionalAt: Date | null, now: Date): boolean {
  return !lastNonTransactionalAt || now.getTime() - lastNonTransactionalAt.getTime() >= NON_TRANSACTIONAL_GAP_MS;
}

export type OwnerEmailDecision = "send" | "suppressed" | "capped";
/** Suppressed owners get no email except a direct reply to a message they sent us. Non-transactional mail is capped. */
export function decideOwnerEmail(i: {
  transactional: boolean; suppressed: boolean; isDirectReply?: boolean; lastNonTransactionalAt: Date | null; now: Date;
}): OwnerEmailDecision {
  if (i.suppressed && !i.isDirectReply) return "suppressed";
  if (!i.transactional && !canSendNonTransactional(i.lastNonTransactionalAt, i.now)) return "capped";
  return "send";
}

export interface RunSummaryLike {
  passed: number; total: number;
  findings: ReadonlyArray<{ title?: string; severity?: string; scenarioId?: string }>;
}
const pts = (r: RunSummaryLike) => (r.total > 0 ? (100 * r.passed) / r.total : 0);
const findingKey = (f: { title?: string; scenarioId?: string }) => f.scenarioId || f.title || "";
const isHigh = (f: { severity?: string }) => f.severity === "high" || f.severity === "critical";

/** Re-run results are emailed only when the score moved >= 5 points or a new high/critical finding appeared. */
export function rerunWorthEmailing(prev: RunSummaryLike, next: RunSummaryLike): { notify: boolean; deltaPts: number; newHigh: string[] } {
  const deltaPts = Math.round((pts(next) - pts(prev)) * 10) / 10;
  const prevKeys = new Set(prev.findings.map(findingKey));
  const newHigh = next.findings.filter((f) => isHigh(f) && !prevKeys.has(findingKey(f))).map((f) => f.title || f.scenarioId || "finding");
  return { notify: Math.abs(deltaPts) >= RERUN_NOTIFY_DELTA_PTS || newHigh.length > 0, deltaPts, newHigh };
}

// ---- signed (stateless) tokens: unsubscribe, operator approve-all -----------------------------

export type SignedPurpose = "unsubscribe" | "owner_results" | "approve_all";

function signingKey(env: Record<string, string | undefined>): string {
  const k = env.SESSION_SECRET;
  if (!k) throw new Error("SESSION_SECRET is not set");
  return k;
}
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const mac = (purpose: string, body: string, key: string) => createHmac("sha256", key).update(`${purpose}.${body}`).digest();

/** HMAC-SHA256 over a JSON payload, bound to a purpose. `exp` (ms epoch) is optional. */
export function signToken(purpose: SignedPurpose, payload: Record<string, unknown>, env: Record<string, string | undefined> = process.env): string {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(mac(purpose, body, signingKey(env)))}`;
}

export function verifySignedToken<T extends Record<string, unknown>>(
  purpose: SignedPurpose, token: string, env: Record<string, string | undefined> = process.env, now = Date.now(),
): T | null {
  if (typeof token !== "string" || token.length > 4096) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  let key: string;
  try { key = signingKey(env); } catch { return null; }
  const expected = mac(purpose, body, key);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: number };
    if (typeof payload.exp === "number" && payload.exp <= now) return null;
    return payload;
  } catch { return null; }
}

export const unsubscribeToken = (email: string, env?: Record<string, string | undefined>) =>
  signToken("unsubscribe", { e: email.trim().toLowerCase() }, env);

/** Salted sha256 of the submitter IP (we never store the raw IP). */
export function ipHash(ip: string, env: Record<string, string | undefined> = process.env): string {
  return createHash("sha256").update(`${env.SESSION_SECRET ?? ""}:ip:${ip}`).digest("hex").slice(0, 32);
}

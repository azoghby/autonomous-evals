import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { isEmailConfigured, sendEmail } from "@ae/core/auth/email";
import { operatorEmails } from "@ae/core/auth/tokens";
import { signToken } from "./owner-policy";
import { appUrl } from "./owner-shared";

export const DIGEST_MAX_DRAFTS = 50;
export const DIGEST_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const APPROVE_ALL_PATH = "/operator/outreach/approve-all";

/** Deterministic UUID-shaped id for the day's claim row. */
export function digestClaimId(now: Date): string {
  const h = createHash("sha256").update(`operator-digest:${now.toISOString().slice(0, 10)}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export interface DigestDraft { id: string; kind: string; toEmail: string; subject: string; createdAt: Date }

export interface DigestPlan { summary: string; tasks: Array<{ assignee: string; title: string; status: string }> }

/** Earliest UTC hour the digest goes out without a plan (the planner cron runs earlier). */
export const DIGEST_EARLIEST_HOUR_UTC = 7;

export interface DigestDeps { loadPlan?: (now: Date) => Promise<DigestPlan | null> }

async function defaultLoadPlan(now: Date): Promise<DigestPlan | null> {
  try {
    const { getDailyPlanSummary } = await import("./company/planner");
    return await getDailyPlanSummary(now);
  } catch (err) {
    console.error("operator digest plan load failed", err instanceof Error ? err.message : err);
    return null;
  }
}

function planSection(plan: DigestPlan): string[] {
  const tasks = plan.tasks.map((t) => `- [${t.status}] ${t.assignee}: ${t.title}`);
  return ["Today's plan (CEO agent)", plan.summary, ...(tasks.length ? ["", ...tasks] : []), ""];
}

export function buildDigestEmail(drafts: DigestDraft[], pending: number, approveAllUrl: string, plan?: DigestPlan | null) {
  const lines = drafts.map((d) => `- [${d.kind}] to ${d.toEmail}: ${d.subject} (${new Date(d.createdAt).toISOString().slice(0, 16)}Z)`);
  const more = pending > drafts.length ? ["...and more (review them in the console)."] : [];
  const planLines = plan ? planSection(plan) : [];
  if (pending === 0 && plan) {
    return {
      subject: "Daily plan from the CEO agent",
      text: [...planLines, `No outreach drafts are waiting. Operator console: ${appUrl()}/operator`].join("\n"),
    };
  }
  return {
    subject: `${pending > DIGEST_MAX_DRAFTS ? `${DIGEST_MAX_DRAFTS}+` : pending} outreach draft${pending === 1 ? "" : "s"} awaiting approval`,
    text: [
      ...planLines,
      `${pending > DIGEST_MAX_DRAFTS ? `${DIGEST_MAX_DRAFTS}+` : pending} outreach draft${pending === 1 ? " is" : "s are"} waiting for your approval.`, "", ...lines, ...more, "",
      `Review in the operator console: ${appUrl()}/operator`, "",
      `Approve and send the ${drafts.length} listed (opens a confirmation page, nothing is sent until you click):`, approveAllUrl,
    ].join("\n"),
  };
}

export async function runOperatorDigest(now: Date, deps: DigestDeps = {}): Promise<{ sent: boolean; pending: number; reason?: string }> {
  const d = schema.outreachDrafts;
  const rows = await db().select({ id: d.id, kind: d.kind, toEmail: d.toEmail, subject: d.subject, createdAt: d.createdAt })
    .from(d).where(eq(d.status, "pending")).orderBy(desc(d.createdAt)).limit(DIGEST_MAX_DRAFTS + 1);
  const plan = await (deps.loadPlan ?? defaultLoadPlan)(now);
  if (rows.length === 0 && !plan) return { sent: false, pending: 0, reason: "none" };
  // The planner runs before the digest window opens; do not claim the day's slot until the plan exists or the window is open.
  if (!plan && now.getUTCHours() < DIGEST_EARLIEST_HOUR_UTC) return { sent: false, pending: rows.length, reason: "waiting_for_plan" };
  const operators = [...operatorEmails()];
  if (operators.length === 0) return { sent: false, pending: rows.length, reason: "no_operators" };
  if (!isEmailConfigured()) return { sent: false, pending: rows.length, reason: "not_configured" };

  const f = schema.followUps;
  const subjectId = digestClaimId(now);
  const claim = await db().insert(f).values({ subjectType: "operator_digest", subjectId, kind: "operator_digest" })
    .onConflictDoNothing().returning({ id: f.id });
  if (claim.length === 0) return { sent: false, pending: rows.length, reason: "already_sent" };

  const listed = rows.slice(0, DIGEST_MAX_DRAFTS);
  // Exact pending count is only needed for the "and N more" line; rows has at most 51.
  const pending = rows.length;
  let delivered = 0;
  for (const op of operators) {
    const token = listed.length === 0 ? null : signToken("approve_all", { ids: listed.map((x) => x.id), op, exp: now.getTime() + DIGEST_TOKEN_TTL_MS });
    const url = token ? `${appUrl()}${APPROVE_ALL_PATH}?t=${encodeURIComponent(token)}` : "";
    const { subject, text } = buildDigestEmail(listed, pending, url, plan);
    try { await sendEmail({ to: op, subject, text, purpose: "auth", labels: ["operator_digest"] }); delivered++; }
    catch (err) { console.error("operator digest send failed", err instanceof Error ? err.message : err); }
  }
  if (delivered === 0) {
    await db().delete(f).where(and(eq(f.subjectType, "operator_digest"), eq(f.subjectId, subjectId), eq(f.kind, "operator_digest")));
    return { sent: false, pending, reason: "send_failed" };
  }
  return { sent: true, pending };
}

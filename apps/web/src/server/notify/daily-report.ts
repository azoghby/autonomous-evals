import "server-only";
import { createHash } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { APPROVE_ALL_PATH, DIGEST_MAX_DRAFTS, DIGEST_TOKEN_TTL_MS } from "../operator-digest";
import { signToken } from "../owner-policy";
import { appUrl } from "../owner-shared";
import { readConfig as readPublicAgentConfig, spentTodayMicroUsd } from "../public-agent-cron";
import { expireStaleApprovals } from "./approvals";
import { sendFounderText, type ChannelResults } from "./channels";
import { getTodaysPlan } from "./daily-plan";
import { formatNotesSection, resolveFounderEmail } from "./founder-email-logic";
import { markNotesReported, unreportedFounderNotes } from "./founder-email";
import { formatDailyReport, meanRate, type DailyMetrics } from "./daily-report-logic";

const DAY_MS = 24 * 60 * 60 * 1000;
/** "fndrrpt" as an int8 key for pg_try_advisory_lock (distinct from the public-agent cron key). */
export const REPORT_LOCK_KEY = 0x666e647272707400n;

/** Deterministic UUID-shaped id for the day's claim row (same scheme as the operator digest, different subject type). */
export function reportClaimId(now: Date): string {
  const h = createHash("sha256").update(`founder-report:${now.toISOString().slice(0, 10)}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const n = (v: unknown) => Number(v ?? 0);

export async function collectDailyMetrics(now = new Date()): Promise<DailyMetrics> {
  const since = new Date(now.getTime() - DAY_MS);
  const d = db();
  const p = schema.payments, j = schema.jobs, pp = schema.planPurchases, sr = schema.sandboxRuns, par = schema.publicAgentRuns;
  const recognized = sql`case ${p.status} when 'captured' then coalesce(${p.capturedAmountCents}, 0) else ${p.amountCents} end`;
  const [jobPay, planPay, signups, jobsStarted, jobsDone, jobsFailed, paused, review, sbStarted, sbDone, pubRuns, spend, drafts, leads, approvals] = await Promise.all([
    d.select({ env: p.environment, cents: sql<string>`coalesce(sum(${recognized}),0)`, c: sql<string>`count(*)` }).from(p)
      .innerJoin(j, eq(j.id, p.jobId)).where(and(inArray(p.status, ["paid", "captured"]), gte(p.createdAt, since), eq(j.isMock, false))).groupBy(p.environment),
    d.select({ env: pp.environment, cents: sql<string>`coalesce(sum(${pp.amountCents}),0)`, c: sql<string>`count(*)` }).from(pp)
      .where(gte(pp.createdAt, since)).groupBy(pp.environment),
    d.select({ c: sql<string>`count(*)` }).from(schema.customers).where(gte(schema.customers.createdAt, since)),
    d.select({ c: sql<string>`count(*)` }).from(j).where(and(gte(j.createdAt, since), sql`${j.state} <> 'draft'`)),
    d.select({ c: sql<string>`count(*)` }).from(j).where(gte(j.deliveredAt, since)),
    d.select({ c: sql<string>`count(*)` }).from(j).where(and(eq(j.state, "failed"), gte(j.updatedAt, since))),
    d.select({ c: sql<string>`count(*)` }).from(j).where(eq(j.state, "paused_budget")),
    d.select({ c: sql<string>`count(*)` }).from(j).where(eq(j.state, "payment_review")),
    d.select({ c: sql<string>`count(*)` }).from(sr).where(gte(sr.createdAt, since)),
    d.select({ rate: sr.passAt1, status: sr.status }).from(sr).where(and(gte(sr.completedAt, since), inArray(sr.status, ["complete", "failed"]))).limit(500),
    d.select({ passed: par.passed, total: par.total }).from(par).where(gte(par.ranAt, since)).limit(500),
    d.select({ s: sql<string>`coalesce(sum(${schema.costs.microUsd}),0)` }).from(schema.costs).where(gte(schema.costs.createdAt, since)),
    d.select({ c: sql<string>`count(*)` }).from(schema.outreachDrafts).where(eq(schema.outreachDrafts.status, "pending")),
    d.select({ c: sql<string>`count(*)` }).from(schema.salesLeads).where(eq(schema.salesLeads.status, "new")),
    d.select({ c: sql<string>`count(*)` }).from(schema.founderApprovals).where(eq(schema.founderApprovals.status, "pending")),
  ]);
  const byEnv = (rows: { env: string; cents: string; c: string }[], env: string) => rows.filter((r) => r.env === env);
  const sum = (rows: { cents: string; c: string }[], k: "cents" | "c") => rows.reduce((a, r) => a + n(r[k]), 0);
  const live = [...byEnv(jobPay, "live"), ...byEnv(planPay, "live")], test = [...byEnv(jobPay, "test"), ...byEnv(planPay, "test")];
  const sbComplete = sbDone.filter((r) => r.status === "complete");
  const pubCfg = readPublicAgentConfig();
  const budgetUsd = Number(process.env.DAILY_SPEND_BUDGET_USD);
  return {
    since,
    revenue: { liveCents: sum(live, "cents"), testCents: sum(test, "cents"), livePurchases: sum(live, "c"), testPurchases: sum(test, "c") },
    signups: n(signups[0]?.c),
    runs: {
      started: n(jobsStarted[0]?.c) + n(sbStarted[0]?.c) + pubRuns.length,
      completed: n(jobsDone[0]?.c) + sbComplete.length + pubRuns.length,
      failed: n(jobsFailed[0]?.c) + (sbDone.length - sbComplete.length),
      avgPassRate: meanRate([...sbComplete.map((r) => r.rate), ...pubRuns.map((r) => (r.total > 0 ? r.passed / r.total : null))]),
    },
    spend: {
      totalMicroUsd: n(spend[0]?.s),
      dailyBudgetMicroUsd: Number.isFinite(budgetUsd) && budgetUsd > 0 ? Math.round(budgetUsd * 1_000_000) : null,
      publicAgentMicroUsd: await spentTodayMicroUsd(now).catch(() => 0),
      publicAgentBudgetMicroUsd: pubCfg.dailyBudgetMicroUsd,
    },
    pending: { approvals: n(approvals[0]?.c), outreachDrafts: n(drafts[0]?.c), newLeads: n(leads[0]?.c) },
    failures: { failedJobs: n(jobsFailed[0]?.c), pausedJobs: n(paused[0]?.c), paymentReview: n(review[0]?.c) },
  };
}

/** Text of the report; appends the operator-digest approve-all link when drafts are pending (confirm page, never auto-sends). */
export async function buildDailyReportText(now = new Date()): Promise<string> {
  const m = await collectDailyMetrics(now);
  const plan = await getTodaysPlan(now).catch(() => null);
  let text = formatDailyReport({ ...m, ...(plan?.length ? { plan } : {}) }, `${appUrl()}/operator`);
  const op = resolveFounderEmail();
  if (m.pending.outreachDrafts > 0 && op) {
    const d = schema.outreachDrafts;
    const ids = (await db().select({ id: d.id }).from(d).where(eq(d.status, "pending")).limit(DIGEST_MAX_DRAFTS)).map((r) => r.id);
    const token = signToken("approve_all", { ids, op, exp: now.getTime() + DIGEST_TOKEN_TTL_MS });
    text += `\nReview all ${ids.length} drafts (confirm page): ${appUrl()}${APPROVE_ALL_PATH}?t=${encodeURIComponent(token)}`;
  }
  return text;
}

export type ReportOutcome = { status: "sent"; results: ChannelResults; expired: number } | { status: "skipped"; reason: string };

/** Once per UTC day (follow_ups claim) and never concurrently (session advisory lock on a dedicated connection). */
export async function runFounderDailyReport(now = new Date()): Promise<ReportOutcome> {
  const { Pool } = await import("@neondatabase/serverless");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    const { rows } = await client.query("select pg_try_advisory_lock($1::bigint) as ok", [REPORT_LOCK_KEY.toString()]);
    if (!rows[0]?.ok) return { status: "skipped", reason: "locked" };
    try {
      const expired = await expireStaleApprovals(now);
      const f = schema.followUps;
      const subjectId = reportClaimId(now);
      const claim = await db().insert(f).values({ subjectType: "founder_report", subjectId, kind: "founder_report" }).onConflictDoNothing().returning({ id: f.id });
      if (claim.length === 0) return { status: "skipped", reason: "already_sent" };
      const notes = await unreportedFounderNotes().catch(() => []);
      const hint = "\n\nReply to respond: YES ALL approves every pending outreach draft; any other text is saved as a note and never acted on.";
      const text = (await buildDailyReportText(now)) + formatNotesSection(notes) + hint;
      const results = await sendFounderText(text, { subject: `Standard Evals daily report — ${now.toISOString().slice(0, 10)}`, threadKind: "report" });
      if (!Object.values(results).some((r) => r === "sent")) {
        // Nothing delivered (no channels or all failed): release the claim so a manual re-run can retry.
        await db().delete(f).where(and(eq(f.subjectType, "founder_report"), eq(f.subjectId, subjectId), eq(f.kind, "founder_report")));
        return { status: "skipped", reason: `not_delivered: ${JSON.stringify(results)}` };
      }
      await markNotesReported(notes.map((n) => n.id), now).catch((err) => console.error("mark notes reported failed", err instanceof Error ? err.message : err));
      return { status: "sent", results, expired };
    } finally {
      await client.query("select pg_advisory_unlock($1::bigint)", [REPORT_LOCK_KEY.toString()]).catch(() => {});
    }
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }
}

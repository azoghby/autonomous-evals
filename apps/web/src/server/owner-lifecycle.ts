import "server-only";
/**
 * Agent-owner autopilot lifecycle tick: (a) [runs are done by the public-agents cron], (b) email run results / re-run results,
 * (c) one-time "fix your top finding" offer. Wired into the follow-ups cron by the lead.
 * Claim-then-send-then-release-on-failure, same as follow-ups.ts deliver(), keyed on follow_ups(subjectType, subjectId, kind).
 */
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { getLeaderboard } from "./leaderboard-db";
import { SUITE_VERSION, type StoredFinding } from "./leaderboard";
import { appUrl, sendOwnerEmail, type PublicAgentRow } from "./owner-shared";
import { FIX_OFFER_DELAY_MS, WEEKLY_RUN_MS, rerunWorthEmailing, signToken, type Visibility } from "./owner-policy";
import { buildFixOfferEmail, buildRerunEmail, buildResultsEmail, topFindings } from "./owner-emails";

export const OWNER_BATCH_LIMIT = 25;
const RUN_TYPE = "public_agent_run";
const AGENT_TYPE = "public_agent";

export interface OwnerLifecycleResult { processed: number; sent: number; skipped: number; errors: string[] }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toDate = (v: Date | string | null | undefined): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));
const iso = (d: Date) => d.toISOString();
const asFindings = (v: unknown): StoredFinding[] => (Array.isArray(v) ? (v as StoredFinding[]) : []);

async function claim(subjectType: string, subjectId: string, kind: string): Promise<boolean> {
  const rows = await db().insert(schema.followUps).values({ subjectType, subjectId, kind }).onConflictDoNothing().returning({ id: schema.followUps.id });
  return rows.length > 0;
}
async function release(subjectType: string, subjectId: string, kind: string): Promise<void> {
  const f = schema.followUps;
  await db().delete(f).where(and(eq(f.subjectType, subjectType), eq(f.subjectId, subjectId), eq(f.kind, kind)));
}

type Outcome = "sent" | "capped" | "skipped" | "error";

interface DeliverInput {
  subjectType: string; subjectId: string; kind: string; agent: PublicAgentRow; transactional: boolean;
  build: () => { subject: string; text: string };
}

/** Claim -> sendOwnerEmail -> release on capped/not-configured/failure. suppressed/no_owner are final: the claim is kept. */
async function deliver(d: DeliverInput, r: OwnerLifecycleResult, now: Date): Promise<Outcome> {
  const label = `${d.subjectType}:${d.subjectId}`;
  if (!(await claim(d.subjectType, d.subjectId, d.kind))) { r.skipped++; return "skipped"; }
  try {
    const { subject, text } = d.build();
    const res = await sendOwnerEmail({ agent: d.agent, kind: d.kind, transactional: d.transactional, subject, text, now });
    if (res.status === "sent") { r.sent++; return "sent"; }
    if (res.status === "capped" || res.status === "not_configured") { await release(d.subjectType, d.subjectId, d.kind); r.skipped++; return "capped"; }
    r.skipped++; // suppressed | no_owner: final
    return "skipped";
  } catch (err) {
    r.errors.push(`${label}: ${d.kind} failed: ${errMsg(err)}`);
    try { await release(d.subjectType, d.subjectId, d.kind); } catch (e2) { r.errors.push(`${label}: cleanup failed: ${errMsg(e2)}`); }
    return "error";
  }
}

const resultsUrl = (a: Pick<PublicAgentRow, "id" | "slug" | "visibility">): string =>
  a.visibility === "public" ? `${appUrl()}/leaderboard/${a.slug}` : `${appUrl()}/leaderboard/owner/${signToken("owner_results", { a: a.id })}`;

// ---- (b) results emails -------------------------------------------------------------------------

interface RunCandidate {
  runId: string; agentId: string; ranAt: Date; passed: number; total: number; findings: StoredFinding[]; agent: PublicAgentRow;
}

async function unclaimedRuns(): Promise<RunCandidate[]> {
  const { publicAgentRuns: run, publicAgents: a, followUps: f } = schema;
  const rows = await db().select({ run, agent: a }).from(run).innerJoin(a, eq(a.id, run.agentId))
    .where(and(
      sql`${a.ownerEmail} is not null`, ne(a.status, "opted_out"),
      sql`not exists (select 1 from ${f} where ${f.subjectType} = ${RUN_TYPE} and ${f.subjectId} = ${run.id} and ${f.kind} in ('owner_results','owner_rerun_results','owner_rerun_quiet'))`,
    )).orderBy(asc(run.ranAt)).limit(OWNER_BATCH_LIMIT);
  return rows.map(({ run: x, agent }) => ({
    runId: x.id, agentId: x.agentId, ranAt: toDate(x.ranAt)!, passed: x.passed, total: x.total, findings: asFindings(x.findings), agent,
  }));
}

async function previousRun(agentId: string, before: Date): Promise<{ passed: number; total: number; findings: StoredFinding[] } | null> {
  const r = schema.publicAgentRuns;
  const [row] = await db().select({ passed: r.passed, total: r.total, findings: r.findings }).from(r)
    .where(and(eq(r.agentId, agentId), lt(r.ranAt, before))).orderBy(desc(r.ranAt)).limit(1);
  return row ? { passed: row.passed, total: row.total, findings: asFindings(row.findings) } : null;
}

type Ranking = { entries: Array<{ slug: string; rank: number }>; ok: boolean };
const pct = (x: { passed: number; total: number }) => (x.total > 0 ? Math.round((100 * x.passed) / x.total) : 0);

async function sendResults(c: RunCandidate, rankingFn: () => Promise<Ranking>, r: OwnerLifecycleResult, now: Date): Promise<void> {
  const a = c.agent;
  const visibility = (a.visibility === "private" ? "private" : "public") as Visibility;
  let rank: number | undefined, totalRanked: number | undefined;
  if (visibility === "public") {
    const { entries } = await rankingFn();
    const me = entries.find((e) => e.slug === a.slug);
    if (me) { rank = me.rank; totalRanked = entries.length; }
  }
  const url = resultsUrl(a);
  await deliver({
    subjectType: RUN_TYPE, subjectId: c.runId, kind: "owner_results", agent: a, transactional: true,
    build: () => buildResultsEmail({
      agentName: a.name, passed: c.passed, total: c.total, rank, totalRanked, findings: c.findings, visibility, resultsUrl: url,
      ...(visibility === "public" ? { badgeMarkdown: `![Standard Evals](${appUrl()}/leaderboard/${a.slug}/badge.svg)` } : {}),
      startUrl: `${appUrl()}/start`,
    }),
  }, r, now);
}

async function processRun(c: RunCandidate, cappedOwners: Set<string>, rankingFn: () => Promise<Ranking>, r: OwnerLifecycleResult, now: Date) {
  const prev = await previousRun(c.agentId, c.ranAt);
  if (!prev) return sendResults(c, rankingFn, r, now);

  const ownerKey = (c.agent.ownerEmail ?? "").toLowerCase();
  const stale = now.getTime() - c.ranAt.getTime() > WEEKLY_RUN_MS;
  const verdict = rerunWorthEmailing({ passed: prev.passed, total: prev.total, findings: prev.findings }, { passed: c.passed, total: c.total, findings: c.findings });
  if (!verdict.notify || stale) { await claim(RUN_TYPE, c.runId, "owner_rerun_quiet"); r.skipped++; return; }
  if (cappedOwners.has(ownerKey)) { r.skipped++; return; }
  const out = await deliver({
    subjectType: RUN_TYPE, subjectId: c.runId, kind: "owner_rerun_results", agent: c.agent, transactional: false,
    build: () => buildRerunEmail({
      agentName: c.agent.name, prevPct: pct(prev), nextPct: pct(c), deltaPts: verdict.deltaPts, newHigh: verdict.newHigh, resultsUrl: resultsUrl(c.agent),
    }),
  }, r, now);
  if (out === "capped") cappedOwners.add(ownerKey);
}

// ---- (c) fix offer ------------------------------------------------------------------------------

interface FixCandidate { agent: PublicAgentRow; findings: StoredFinding[] }

async function fixOfferCandidates(now: Date): Promise<FixCandidate[]> {
  const { followUps: f, publicAgentRuns: run, publicAgents: a } = schema;
  const rows = await db().select({ agent: a, findings: run.findings }).from(f)
    .innerJoin(run, eq(run.id, f.subjectId)).innerJoin(a, eq(a.id, run.agentId))
    .where(and(
      eq(f.subjectType, RUN_TYPE), eq(f.kind, "owner_results"), lt(f.sentAt, new Date(now.getTime() - FIX_OFFER_DELAY_MS)),
      sql`${a.ownerEmail} is not null`, inArray(a.status, ["pending_verification", "active", "paused"]),
      sql`not exists (select 1 from ${f} f2 where f2.subject_type = ${AGENT_TYPE} and f2.subject_id = ${a.id} and f2.kind = 'owner_fix_offer')`,
    )).orderBy(asc(f.sentAt)).limit(OWNER_BATCH_LIMIT);
  return rows.map((x) => ({ agent: x.agent, findings: asFindings(x.findings) }));
}

// ---- tick ---------------------------------------------------------------------------------------

export async function runOwnerLifecycle(opts: { now?: Date; deadline: number }): Promise<OwnerLifecycleResult> {
  const now = opts.now ?? new Date();
  const r: OwnerLifecycleResult = { processed: 0, sent: 0, skipped: 0, errors: [] };
  const timeLeft = () => Date.now() < opts.deadline;

  // (b) results emails
  let ranking: Promise<Ranking> | undefined;
  const rankingFn = () => (ranking ??= getLeaderboard(SUITE_VERSION));
  const cappedOwners = new Set<string>();
  let candidates: RunCandidate[] = [];
  try { candidates = await unclaimedRuns(); } catch (e) { r.errors.push(`owner_results:query: ${errMsg(e)}`); }
  for (const c of candidates) {
    if (!timeLeft()) return r;
    r.processed++;
    try { await processRun(c, cappedOwners, rankingFn, r, now); }
    catch (e) { r.errors.push(`${RUN_TYPE}:${c.runId}: ${errMsg(e)}`); }
  }

  // (c) fix offers
  let fixes: FixCandidate[] = [];
  try { fixes = await fixOfferCandidates(now); } catch (e) { r.errors.push(`owner_fix_offer:query: ${errMsg(e)}`); }
  for (const c of fixes) {
    if (!timeLeft()) return r;
    r.processed++;
    const ownerKey = (c.agent.ownerEmail ?? "").toLowerCase();
    const top = topFindings(c.findings, 1)[0];
    if (!top || cappedOwners.has(ownerKey)) { r.skipped++; continue; }
    try {
      const out = await deliver({
        subjectType: AGENT_TYPE, subjectId: c.agent.id, kind: "owner_fix_offer", agent: c.agent, transactional: false,
        build: () => buildFixOfferEmail({ agentName: c.agent.name, finding: top, startUrl: `${appUrl()}/start` }),
      }, r, now);
      if (out === "capped") cappedOwners.add(ownerKey);
    } catch (e) { r.errors.push(`${AGENT_TYPE}:${c.agent.id}: ${errMsg(e)}`); }
  }
  return r;
}

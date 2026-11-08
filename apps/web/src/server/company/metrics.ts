import "server-only";
/** Aggregate company metrics for the planner. Counts and money only: no PII ever leaves this module. */
import { and, desc, eq, gte, inArray, like, ne, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { startOfUtcDay } from "@ae/core/company/policy";
import { CompanyMetricsSchema, type CompanyMetrics } from "@ae/core/company/planner";
import { getRevenueStats } from "../revenue";

const DAY_MS = 24 * 60 * 60 * 1000;
const HEADLINE_MAX = 200;

const toCountMap = (rows: Array<{ key: string | null; n: string | number }>): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.key ?? "unknown", Number(r.n)]));

async function revenueSince(since: Date): Promise<number> {
  const p = schema.planPurchases;
  const [purchases] = await db().select({ cents: sql<string>`coalesce(sum(${p.amountCents}), 0)` }).from(p)
    .where(and(eq(p.environment, "live"), ne(p.status, "canceled"), gte(p.createdAt, since)));
  const payments = await getRevenueStats(since);
  return Number(purchases?.cents ?? 0) + payments.revenueCents;
}

async function sumCost(since: Date, companyOnly: boolean): Promise<number> {
  const c = schema.costs;
  const where = companyOnly ? and(like(c.agent, "company:%"), gte(c.createdAt, since)) : gte(c.createdAt, since);
  const [row] = await db().select({ total: sql<string>`coalesce(sum(${c.microUsd}), 0)` }).from(c).where(where);
  return Number(row?.total ?? 0);
}

/** Pulls a short headline out of the (loosely typed) market brief JSON. */
export function briefHeadline(brief: unknown): string {
  if (!brief || typeof brief !== "object") return "";
  const b = brief as Record<string, unknown>;
  const v = [b.headline, b.title, b.summary].find((x): x is string => typeof x === "string" && x.trim().length > 0);
  return (v ?? "").replace(/\s+/g, " ").trim().slice(0, HEADLINE_MAX);
}

async function groupCount<T extends { key: unknown }>(q: Promise<T[]>): Promise<Array<{ key: string | null; n: number }>> {
  return (await q).map((r) => ({ key: r.key as string | null, n: Number((r as unknown as { n: string }).n) }));
}

export async function getCompanyMetrics(now: Date = new Date()): Promise<CompanyMetrics> {
  const d1 = new Date(now.getTime() - DAY_MS);
  const d7 = new Date(now.getTime() - 7 * DAY_MS);
  const d30 = new Date(now.getTime() - 30 * DAY_MS);
  const cust = schema.customers, run = schema.sandboxRuns, lead = schema.prospectLeads, dr = schema.outreachDrafts;
  const act = schema.companyAgentActivity, br = schema.marketBriefs;
  const count = sql<string>`count(*)`;

  const [r1, r7, r30, plans, runs, leads, newLeads, drafts, today, week, model7, failures, brief] = await Promise.all([
    revenueSince(d1), revenueSince(d7), revenueSince(d30),
    groupCount(db().select({ key: cust.plan, n: count }).from(cust).where(eq(cust.isInternalFixture, false)).groupBy(cust.plan)),
    groupCount(db().select({ key: run.status, n: count }).from(run).where(gte(run.createdAt, d7)).groupBy(run.status)),
    groupCount(db().select({ key: lead.status, n: count }).from(lead).groupBy(lead.status)),
    db().select({ n: count }).from(lead).where(gte(lead.createdAt, d1)),
    groupCount(db().select({ key: dr.status, n: count }).from(dr).groupBy(dr.status)),
    sumCost(startOfUtcDay(now), true), sumCost(d7, true), sumCost(d7, false),
    db().select({ n: count }).from(act).where(and(gte(act.startedAt, d1), inArray(act.status, ["failed", "budget"]))),
    db().select({ date: br.briefDate, brief: br.brief }).from(br).orderBy(desc(br.briefDate)).limit(1),
  ]);

  const runsByStatus = toCountMap(runs);
  const draftsByStatus = toCountMap(drafts);
  const latest = brief[0];
  return CompanyMetricsSchema.parse({
    generatedAt: now.toISOString(),
    revenueCents: { d1: r1, d7: r7, d30: r30 },
    customersByPlan: toCountMap(plans),
    sandboxRuns7d: { byStatus: runsByStatus, failed: runsByStatus.failed ?? 0 },
    prospects: { byStatus: toCountMap(leads), newLast1d: Number(newLeads[0]?.n ?? 0) },
    outreach: { byStatus: draftsByStatus, pendingApproval: draftsByStatus.pending ?? 0 },
    spendMicroUsd: { companyToday: today, company7d: week, totalModel7d: model7 },
    agentFailures1d: Number(failures[0]?.n ?? 0),
    marketBrief: latest ? { date: latest.date, headline: briefHeadline(latest.brief) } : null,
  });
}

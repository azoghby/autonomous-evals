import "server-only";
/** Operator revenue metrics from real DB rows. Counts and money only: no PII. Test-mode data is kept separate from live. */
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { getStripeMode } from "@ae/core/payments/stripe";
import { getRevenueStats } from "./revenue";
import { computeGrossMargin, computeMrr, type GrossMargin, type MrrByEnv, type RevenueEnv, type SubscriptionInput } from "./revenue-metrics-core";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;

export interface RevenueMetrics {
  generatedAt: string;
  stripeMode: "test" | "live";
  windowDays: number;
  mrr: MrrByEnv;
  /** Collected in the window (subscriptions/audits + job payments + billed overage). */
  revenue30dCents: { live: number; test: number };
  cost30dMicroUsd: number;
  /** Margin on LIVE revenue. */
  grossMargin: GrossMargin;
  /** Illustrative only: test-mode "revenue" against the same costs. Not real margin. */
  testGrossMargin: GrossMargin;
  runs30d: { total: number; byStatus: Record<string, number>; trialsTotal: number };
  customersByPlan: Record<string, number>;
}

type EnvName = "live" | "test";

async function purchaseRevenue(env: EnvName, since: Date): Promise<number> {
  const p = schema.planPurchases;
  const [row] = await db().select({ cents: sql<string>`coalesce(sum(${p.amountCents}), 0)` }).from(p)
    .where(and(eq(p.environment, env), ne(p.status, "canceled"), gte(p.createdAt, since)));
  return Number(row?.cents ?? 0);
}

/** Same status rules as getRevenueStats (paid = amount, captured = capturedAmount), for test-mode payments on non-mock jobs. */
async function testPaymentRevenue(since: Date): Promise<number> {
  const p = schema.payments;
  const recognized = sql`case ${p.status} when 'captured' then coalesce(${p.capturedAmountCents}, 0) else ${p.amountCents} end`;
  const [row] = await db().select({ cents: sql<string>`coalesce(sum(${recognized}), 0)` }).from(p)
    .innerJoin(schema.jobs, eq(schema.jobs.id, p.jobId))
    .where(and(eq(p.environment, "test"), eq(schema.jobs.isMock, false), inArray(p.status, ["paid", "captured"]), gte(p.createdAt, since)));
  return Number(row?.cents ?? 0);
}

async function overageRevenue(env: EnvName, since: Date): Promise<number> {
  const o = schema.overageCharges;
  try {
    const [row] = await db().select({ cents: sql<string>`coalesce(sum(${o.amountCents}), 0)` }).from(o)
      .where(and(eq(o.environment, env), eq(o.status, "billed"), gte(o.billedAt, since)));
    return Number(row?.cents ?? 0);
  } catch (err) {
    // Before migration 0027 is applied the table does not exist: no overage has been billed, so 0 is the truth.
    const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
    if (code === "42P01") return 0;
    throw err;
  }
}

async function loadSubscriptions(): Promise<SubscriptionInput[]> {
  const c = schema.customers, p = schema.planPurchases;
  const custs = await db().select({ id: c.id, plan: c.plan, interval: c.planInterval, status: c.planStatus }).from(c)
    .where(and(eq(c.isInternalFixture, false), inArray(c.plan, ["pro", "scale"])));
  if (custs.length === 0) return [];
  const purchases = await db().select({ customerId: p.customerId, environment: p.environment }).from(p)
    .where(and(eq(p.kind, "subscription"), inArray(p.customerId, custs.map((x) => x.id))))
    .orderBy(desc(p.createdAt));
  const envByCustomer = new Map<string, RevenueEnv>();
  for (const r of purchases) if (r.customerId && !envByCustomer.has(r.customerId)) envByCustomer.set(r.customerId, r.environment === "live" ? "live" : "test");
  return custs.map((x) => ({ plan: x.plan, interval: x.interval, status: x.status, environment: envByCustomer.get(x.id) ?? "unknown" }));
}

const toMap = (rows: Array<{ key: string | null; n: string | number }>): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.key ?? "unknown", Number(r.n)]));

export async function getRevenueMetrics(now: Date = new Date()): Promise<RevenueMetrics> {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const cust = schema.customers, run = schema.sandboxRuns, cost = schema.costs;
  const [subs, livePurchases, testPurchases, liveJobs, testJobs, liveOverage, testOverage, costRow, runRows, planRows] = await Promise.all([
    loadSubscriptions(),
    purchaseRevenue("live", since), purchaseRevenue("test", since),
    getRevenueStats(since), testPaymentRevenue(since),
    overageRevenue("live", since), overageRevenue("test", since),
    db().select({ total: sql<string>`coalesce(sum(${cost.microUsd}), 0)` }).from(cost).where(gte(cost.createdAt, since)),
    db().select({ key: run.status, n: sql<string>`count(*)`, trials: sql<string>`coalesce(sum(${run.trialsTotal}), 0)` }).from(run).where(gte(run.createdAt, since)).groupBy(run.status),
    db().select({ key: cust.plan, n: sql<string>`count(*)` }).from(cust).where(eq(cust.isInternalFixture, false)).groupBy(cust.plan),
  ]);

  const live = livePurchases + liveJobs.revenueCents + liveOverage;
  const test = testPurchases + testJobs + testOverage;
  const costMicroUsd = Number(costRow[0]?.total ?? 0);
  return {
    generatedAt: now.toISOString(),
    stripeMode: getStripeMode(),
    windowDays: WINDOW_DAYS,
    mrr: computeMrr(subs),
    revenue30dCents: { live, test },
    cost30dMicroUsd: costMicroUsd,
    grossMargin: computeGrossMargin(live, costMicroUsd),
    testGrossMargin: computeGrossMargin(test, costMicroUsd),
    runs30d: { total: runRows.reduce((a, r) => a + Number(r.n), 0), byStatus: toMap(runRows), trialsTotal: runRows.reduce((a, r) => a + Number(r.trials), 0) },
    customersByPlan: toMap(planRows),
  };
}

/** Pure revenue maths for the operator Revenue tab. No I/O, no server-only import: unit-testable. */
import { planPriceCents, type BillingInterval, type SelfServePlanId } from "@ae/core/pricing/plans";

export type RevenueEnv = "live" | "test" | "unknown";
export const REVENUE_ENVS: readonly RevenueEnv[] = ["live", "test", "unknown"] as const;
export const ACTIVE_SUBSCRIPTION_STATUSES: readonly string[] = ["active", "trialing", "past_due"] as const;
const MONTHS_PER_YEAR = 12;
const MICRO_USD_PER_CENT = 10_000;

export interface SubscriptionInput {
  plan: string;
  interval: string | null;
  status: string | null;
  environment: RevenueEnv;
}

export interface PlanMrr { count: number; mrrCents: number }
export interface EnvMrr {
  mrrCents: number;
  arrCents: number;
  activeCustomers: number;
  byPlan: { pro: PlanMrr; scale: PlanMrr };
}
export type MrrByEnv = Record<RevenueEnv, EnvMrr>;

const emptyEnv = (): EnvMrr => ({ mrrCents: 0, arrCents: 0, activeCustomers: 0, byPlan: { pro: { count: 0, mrrCents: 0 }, scale: { count: 0, mrrCents: 0 } } });

/** Monthly-equivalent cents for a self-serve subscription; annual = (10 months price) / 12, rounded. */
export function monthlyEquivalentCents(plan: SelfServePlanId, interval: BillingInterval): number {
  return interval === "year" ? Math.round(planPriceCents(plan, "year") / MONTHS_PER_YEAR) : planPriceCents(plan, "month");
}

export function computeMrr(subs: readonly SubscriptionInput[]): MrrByEnv {
  const out: MrrByEnv = { live: emptyEnv(), test: emptyEnv(), unknown: emptyEnv() };
  for (const s of subs) {
    if (!s.status || !ACTIVE_SUBSCRIPTION_STATUSES.includes(s.status)) continue;
    // enterprise/developer: never invent contract values; only self-serve plans carry list-price MRR.
    if (s.plan !== "pro" && s.plan !== "scale") continue;
    const interval: BillingInterval = s.interval === "year" ? "year" : "month";
    const cents = monthlyEquivalentCents(s.plan, interval);
    const env = out[s.environment];
    env.activeCustomers += 1;
    env.mrrCents += cents;
    env.byPlan[s.plan].count += 1;
    env.byPlan[s.plan].mrrCents += cents;
  }
  for (const e of REVENUE_ENVS) out[e].arrCents = out[e].mrrCents * MONTHS_PER_YEAR;
  return out;
}

export interface GrossMargin {
  revenueCents: number;
  costCents: number;
  grossProfitCents: number;
  /** Percentage, one decimal; null when there is no revenue (a margin of nothing is undefined). */
  marginPct: number | null;
}

export function computeGrossMargin(revenueCents: number, costMicroUsd: number): GrossMargin {
  const costCents = Math.round(costMicroUsd / MICRO_USD_PER_CENT);
  const grossProfitCents = revenueCents - costCents;
  const marginPct = revenueCents > 0 ? Math.round((grossProfitCents / revenueCents) * 1000) / 10 : null;
  return { revenueCents, costCents, grossProfitCents, marginPct };
}

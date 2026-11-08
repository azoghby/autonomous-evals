import { PLANS, overageCents, type PlanId } from "./plans";

export interface UsagePeriod {
  /** Inclusive UTC month start. */
  start: Date;
  /** Exclusive UTC month end (start of the next month). */
  end: Date;
}

export interface OverageQuote {
  includedTrials: number;
  overageTrials: number;
  amountCents: number;
}

/** The UTC calendar month before `now`. */
export function previousUsagePeriod(now: Date = new Date()): UsagePeriod {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

/** "YYYY-MM" label of a period start (UTC). */
export function periodLabel(periodStart: Date): string {
  return periodStart.toISOString().slice(0, 7);
}

/** Overage for a month's usage. Plans without overage or without a numeric allowance always yield 0. */
export function computeOverage(a: { plan: PlanId; trialsUsed: number }): OverageQuote {
  const { trialsPerMonth, overageAllowed } = PLANS[a.plan].limits;
  const used = Math.max(0, Math.floor(a.trialsUsed));
  if (!overageAllowed || trialsPerMonth == null) return { includedTrials: trialsPerMonth ?? 0, overageTrials: 0, amountCents: 0 };
  return { includedTrials: trialsPerMonth, overageTrials: Math.max(0, used - trialsPerMonth), amountCents: overageCents(a.plan, used) };
}

/** Stable Stripe idempotency key: one invoice item per customer per usage month. */
export function overageIdempotencyKey(customerId: string, periodStart: Date): string {
  return `overage:${customerId}:${periodLabel(periodStart)}`;
}

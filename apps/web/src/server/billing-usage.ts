import "server-only";
import { getCustomerPlan } from "@ae/core/payments/plans-checkout";
import {
  OVERAGE_CENTS_PER_TRIAL, PLANS, formatUsd, overageCents, usageWindowStart, type PlanId,
} from "@ae/core/pricing/plans";
import { createDbSandboxStore } from "./sandbox/store";

export type UsageStatus = "ok" | "near_limit" | "at_limit";

export interface UsageUpgrade {
  targetPlan: PlanId;
  reason: string;
}

export interface UsageSummary {
  plan: PlanId;
  planName: string;
  trials: { used: number; included: number | null; pct: number };
  environments: { used: number; max: number | null };
  modelSpend: { usedMicroUsd: number; capMicroUsd: number | null };
  projectedOverageCents: number;
  status: UsageStatus;
  upgrade: UsageUpgrade | null;
  /** First instant of the next UTC month (when included trials and the free spend cap reset). */
  resetsAt: string;
}

export interface UsageInput {
  plan: PlanId;
  trialsUsed: number;
  environments: number;
  modelSpendMicroUsd: number;
  now: Date;
}

const NEAR_LIMIT_RATIO = 0.8;
const NEXT_PLAN: Partial<Record<PlanId, PlanId>> = { developer: "pro", pro: "scale", scale: "enterprise" };

const ratio = (used: number, cap: number | null): number => (cap == null || cap <= 0 ? 0 : used / cap);

function nextUtcMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function statusFor(ratios: readonly number[]): UsageStatus {
  const max = Math.max(0, ...ratios);
  if (max >= 1) return "at_limit";
  return max >= NEAR_LIMIT_RATIO ? "near_limit" : "ok";
}

function freePlanReason(status: UsageStatus, ratios: { trials: number; envs: number }): string {
  const what = ratios.trials >= NEAR_LIMIT_RATIO ? "monthly trials" : ratios.envs >= NEAR_LIMIT_RATIO ? "environment" : "monthly model spend cap";
  return status === "at_limit"
    ? `You have reached your Developer ${what} limit, so new runs are paused. Pro adds 2,500 trials a month, 3 environments and no spend cap.`
    : `You are close to your Developer ${what} limit. Pro adds 2,500 trials a month, 3 environments and no spend cap.`;
}

function paidUpgrade(plan: PlanId, status: UsageStatus, trialsRatio: number, envsRatio: number, overage: number): UsageUpgrade | null {
  const target = NEXT_PLAN[plan];
  if (!target || status === "ok") return null;
  const nextName = PLANS[target].name;
  if (envsRatio >= 1) {
    return { targetPlan: target, reason: `You are using every environment on ${PLANS[plan].name}. ${nextName} includes more.` };
  }
  if (trialsRatio < 1) return null;
  const current = PLANS[plan].monthlyCents ?? 0;
  const nextPrice = PLANS[target].monthlyCents;
  // Scale -> Enterprise has no list price: suggest it once overage alone would cost a Scale plan's monthly price.
  const threshold = nextPrice == null ? current : nextPrice - current;
  if (overage <= threshold) return null;
  return {
    targetPlan: target,
    reason: nextPrice == null
      ? `Projected overage of ${formatUsd(overage)} this month. Enterprise volume pricing is likely cheaper.`
      : `Projected overage of ${formatUsd(overage)} this month is more than the ${formatUsd(threshold)} difference to ${nextName}, which includes more trials.`,
  };
}

/** Pure: turns raw usage counters into the meters, status and upgrade suggestion the billing UI renders. */
export function buildUsageSummary(input: UsageInput): UsageSummary {
  const { plan, trialsUsed, environments, modelSpendMicroUsd, now } = input;
  const limits = PLANS[plan].limits;
  const included = limits.trialsPerMonth;
  const trialsRatio = ratio(trialsUsed, included);
  const envsRatio = ratio(environments, limits.environments);
  const spendRatio = ratio(modelSpendMicroUsd, limits.monthlyModelSpendCapMicroUsd);
  const status = statusFor([trialsRatio, envsRatio, spendRatio]);
  const projectedOverageCents = overageCents(plan, trialsUsed);

  const upgrade: UsageUpgrade | null = plan === "developer"
    ? (status === "ok" ? null : { targetPlan: "pro", reason: freePlanReason(status, { trials: Math.max(trialsRatio, spendRatio), envs: envsRatio }) })
    : paidUpgrade(plan, status, trialsRatio, envsRatio, projectedOverageCents);

  return {
    plan,
    planName: PLANS[plan].name,
    trials: { used: trialsUsed, included, pct: included ? Math.round(trialsRatio * 100) : 0 },
    environments: { used: environments, max: limits.environments },
    modelSpend: { usedMicroUsd: modelSpendMicroUsd, capMicroUsd: limits.monthlyModelSpendCapMicroUsd },
    projectedOverageCents,
    status,
    upgrade,
    resetsAt: nextUtcMonthStart(now).toISOString(),
  };
}

/** What happens past the included trials on paid plans (shown on the billing page). */
export function overageNotice(): string {
  return `Overage is now billed at ${formatUsd(OVERAGE_CENTS_PER_TRIAL)} per trial.`;
}

/** Loads the customer's plan and this month's usage, then summarizes it. */
export async function getUsageSummary(customerId: string, now: Date = new Date()): Promise<UsageSummary> {
  const store = createDbSandboxStore();
  const [plan, usage, environments] = await Promise.all([
    getCustomerPlan(customerId),
    store.usageSince(customerId, usageWindowStart(now)),
    store.countEnvironments(customerId),
  ]);
  return buildUsageSummary({ plan, trialsUsed: usage.trials, environments, modelSpendMicroUsd: usage.costMicroUsd, now });
}

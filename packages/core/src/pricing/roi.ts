/**
 * ROI / cost-of-agent-failure calculator. Pure: every number is derived from the caller's own assumptions plus the
 * published plan prices in ./plans. Nothing here is a benchmark, a guarantee or a claim about any customer.
 * All money is USD cents unless a field name says otherwise.
 */
import { OVERAGE_CENTS_PER_TRIAL, PLANS, formatUsd, type PlanId } from "./plans";

export interface RoiInputs {
  /** Agent conversations per month. */
  agentConversationsPerMonth: number;
  /** Estimated % of conversations where the agent does something wrong today. */
  failureRatePct: number;
  /** What one failure costs you: refund, churn, escalation, support time. USD. */
  costPerFailureUsd: number;
  /** Assumed % of failure cost you remove by finding and fixing issues before release. An assumption, not a promise. */
  expectedReductionPct: number;
  /** Distinct scenarios you want to test each release. */
  scenariosToTest: number;
  /** Trials per scenario (pass^k needs repeats). */
  k: number;
  /** Releases (prompt, model or tool changes) you test per month. */
  releasesPerMonth: number;
}

export const ROI_DEFAULTS: Readonly<RoiInputs> = {
  agentConversationsPerMonth: 20_000,
  failureRatePct: 3,
  costPerFailureUsd: 40,
  expectedReductionPct: 30,
  scenariosToTest: 40,
  k: 4,
  releasesPerMonth: 4,
};

interface Bound { min: number; max: number; integer: boolean }
export const ROI_BOUNDS: Readonly<Record<keyof RoiInputs, Bound>> = {
  agentConversationsPerMonth: { min: 0, max: 10_000_000, integer: true },
  failureRatePct: { min: 0, max: 100, integer: false },
  costPerFailureUsd: { min: 0, max: 1_000_000, integer: false },
  expectedReductionPct: { min: 0, max: 100, integer: false },
  scenariosToTest: { min: 0, max: 10_000, integer: true },
  k: { min: 1, max: 100, integer: true },
  releasesPerMonth: { min: 0, max: 1_000, integer: true },
};

/** Above this many trials a month we stop quoting list prices and route to a volume conversation. */
export const ENTERPRISE_TRIALS_THRESHOLD = 50_000;
/** Payback longer than this is reported as null (not meaningful). */
export const MAX_MEANINGFUL_PAYBACK_DAYS = 365;
const DAYS_PER_MONTH = 30;

export type RoiRawInputs = Partial<Record<keyof RoiInputs, unknown>>;

export interface RoiResult {
  /** The clamped inputs actually used. */
  inputs: RoiInputs;
  monthlyFailureCostCents: number;
  avoidableCostCents: number;
  trialsNeededPerMonth: number;
  recommendedPlan: PlanId;
  /** Plan fee plus projected overage; null for Enterprise (custom pricing). */
  planMonthlyCostCents: number | null;
  projectedOverageTrials: number;
  /** avoidable minus plan cost; null for Enterprise. */
  netMonthlyValueCents: number | null;
  /** avoidable / plan cost, one decimal; null on the free plan, Enterprise, or zero avoidable cost. */
  roiMultiple: number | null;
  /** Days of avoided failure cost needed to cover one month of plan cost; null when not meaningful. */
  paybackDays: number | null;
  rationale: {
    failureCost: string;
    avoidable: string;
    trials: string;
    plan: string;
    roi: string;
    payback: string;
  };
}

/** Coerce anything to a finite number inside the field's bounds. NaN/undefined/non-numbers fall back to the default. */
export function clampInput(field: keyof RoiInputs, value: unknown): number {
  const { min, max, integer } = ROI_BOUNDS[field];
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (Number.isNaN(n)) return ROI_DEFAULTS[field];
  const bounded = Math.min(max, Math.max(min, n));
  return integer ? Math.floor(bounded) : bounded;
}

export function normalizeRoiInputs(raw: RoiRawInputs = {}): RoiInputs {
  return {
    agentConversationsPerMonth: clampInput("agentConversationsPerMonth", raw.agentConversationsPerMonth),
    failureRatePct: clampInput("failureRatePct", raw.failureRatePct),
    costPerFailureUsd: clampInput("costPerFailureUsd", raw.costPerFailureUsd),
    expectedReductionPct: clampInput("expectedReductionPct", raw.expectedReductionPct),
    scenariosToTest: clampInput("scenariosToTest", raw.scenariosToTest),
    k: clampInput("k", raw.k),
    releasesPerMonth: clampInput("releasesPerMonth", raw.releasesPerMonth),
  };
}

function listCents(plan: "pro" | "scale", trials: number): { total: number; overage: number } {
  const included = PLANS[plan].limits.trialsPerMonth ?? 0;
  const overage = Math.max(0, trials - included);
  return { total: (PLANS[plan].monthlyCents ?? 0) + overage * OVERAGE_CENTS_PER_TRIAL, overage };
}

export interface PlanChoice { plan: PlanId; costCents: number | null; overage: number; reason: string }

const fmtInt = (n: number): string => n.toLocaleString("en-US");

export function choosePlan(trials: number): PlanChoice {
  const devCap = PLANS.developer.limits.trialsPerMonth ?? 0;
  if (trials <= devCap) {
    return { plan: "developer", costCents: 0, overage: 0, reason: `${fmtInt(trials)} trials a month fits the free Developer plan (${fmtInt(devCap)} included).` };
  }
  if (trials > ENTERPRISE_TRIALS_THRESHOLD) {
    return { plan: "enterprise", costCents: null, overage: 0, reason: `${fmtInt(trials)} trials a month is past ${fmtInt(ENTERPRISE_TRIALS_THRESHOLD)}, where list-price overage stops making sense. Talk to us about volume pricing.` };
  }
  const pro = listCents("pro", trials);
  const scale = listCents("scale", trials);
  if (pro.overage === 0) {
    return { plan: "pro", costCents: pro.total, overage: 0, reason: `${fmtInt(trials)} trials fits inside Pro's ${fmtInt(PLANS.pro.limits.trialsPerMonth ?? 0)} included trials.` };
  }
  if (pro.total <= scale.total) {
    return { plan: "pro", costCents: pro.total, overage: pro.overage, reason: `Pro plus ${fmtInt(pro.overage)} overage trials at ${formatUsd(OVERAGE_CENTS_PER_TRIAL)} (${formatUsd(pro.total)}) is cheaper than Scale (${formatUsd(scale.total)}).` };
  }
  const reason = scale.overage === 0
    ? `Scale's ${fmtInt(PLANS.scale.limits.trialsPerMonth ?? 0)} included trials cover ${fmtInt(trials)}, and it costs less than Pro with overage (${formatUsd(pro.total)}).`
    : `Scale plus ${fmtInt(scale.overage)} overage trials (${formatUsd(scale.total)}) is cheaper than Pro with overage (${formatUsd(pro.total)}).`;
  return { plan: "scale", costCents: scale.total, overage: scale.overage, reason };
}

export function calculateRoi(raw: RoiRawInputs = {}): RoiResult {
  const inputs = normalizeRoiInputs(raw);
  const failures = (inputs.agentConversationsPerMonth * inputs.failureRatePct) / 100;
  const monthlyFailureCostCents = Math.round(failures * inputs.costPerFailureUsd * 100);
  const avoidableCostCents = Math.round((monthlyFailureCostCents * inputs.expectedReductionPct) / 100);
  const trialsNeededPerMonth = inputs.scenariosToTest * inputs.k * inputs.releasesPerMonth;

  const choice = choosePlan(trialsNeededPerMonth);
  const planCost = choice.costCents;
  const netMonthlyValueCents = planCost == null ? null : avoidableCostCents - planCost;

  const paying = planCost != null && planCost > 0;
  const roiMultiple = paying && avoidableCostCents > 0 ? Math.round((avoidableCostCents / planCost) * 10) / 10 : null;

  let paybackDays: number | null = null;
  if (paying && avoidableCostCents > 0) {
    const days = Math.max(1, Math.ceil((planCost / avoidableCostCents) * DAYS_PER_MONTH));
    paybackDays = days <= MAX_MEANINGFUL_PAYBACK_DAYS ? days : null;
  }

  const rationale = {
    failureCost: `${fmtInt(inputs.agentConversationsPerMonth)} conversations x ${inputs.failureRatePct}% failing x ${formatUsd(Math.round(inputs.costPerFailureUsd * 100))} each.`,
    avoidable: `${inputs.expectedReductionPct}% of that is the share you assume testing lets you catch and fix before release. It is your assumption, not a promise.`,
    trials: `${fmtInt(inputs.scenariosToTest)} scenarios x ${inputs.k} trials each x ${fmtInt(inputs.releasesPerMonth)} releases a month.`,
    plan: choice.reason,
    roi: roiMultiple != null
      ? `Avoidable cost divided by ${formatUsd(planCost ?? 0)} a month in plan cost.`
      : planCost === 0 ? "The plan is free, so there is no ratio to show."
      : planCost == null ? "Enterprise pricing is custom, so no ratio is shown."
      : "No avoidable cost under these assumptions, so there is no ratio to show.",
    payback: paybackDays != null
      ? `About ${paybackDays} day${paybackDays === 1 ? "" : "s"} of avoided failure cost covers a month of the plan.`
      : "Not shown: either the plan is free, pricing is custom, nothing is avoided, or payback would exceed a year.",
  };

  return {
    inputs, monthlyFailureCostCents, avoidableCostCents, trialsNeededPerMonth,
    recommendedPlan: choice.plan, planMonthlyCostCents: planCost, projectedOverageTrials: choice.overage,
    netMonthlyValueCents, roiMultiple, paybackDays, rationale,
  };
}

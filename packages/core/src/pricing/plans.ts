/**
 * Single source of truth for Standard Evals plans, limits, prices and overage.
 * Every surface (marketing pages, Stripe setup, checkout, sandbox limit enforcement, MCP quotes) reads from here.
 * All prices are USD cents. Nothing here performs I/O.
 */

export const PLAN_IDS = ["developer", "pro", "scale", "enterprise"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Plans a customer can buy self-serve through Stripe Checkout (subscription). */
export const SELF_SERVE_PLAN_IDS = ["pro", "scale"] as const;
export type SelfServePlanId = (typeof SELF_SERVE_PLAN_IDS)[number];

export const BILLING_INTERVALS = ["month", "year"] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** Annual billing: pay for 10 months, get 12 ("2 months free"). */
export const ANNUAL_MONTHS_BILLED = 10;

/** $0.20 per trial beyond the plan's included trials. */
export const OVERAGE_CENTS_PER_TRIAL = 20;

/** Model tokens the agent under test spends on our AI Gateway are passed through at cost (0% markup). BYO key = $0. */
export const MODEL_TOKEN_MARKUP_PERCENT = 0;

/**
 * Developer (free) hard cap on what we spend on models per account per calendar month (simulator, judge, gateway
 * target tokens). Enforced in the sandbox service by shrinking/refusing run and suite budgets.
 */
export const FREE_MONTHLY_MODEL_SPEND_CAP_MICRO_USD = 2_000_000;

export interface PlanFeature {
  label: string;
  /** Shown as "coming soon" in fine print; never claimed as available. */
  comingSoon?: boolean;
}

export interface PlanLimits {
  /** Max sandbox environments an account may keep. null = unlimited / custom. */
  environments: number | null;
  /** Included trials per calendar month (UTC). null = custom. */
  trialsPerMonth: number | null;
  /** Whether trials beyond trialsPerMonth are allowed (billed as overage). Free plan: hard stop. */
  overageAllowed: boolean;
  /** Hard cap on our model spend per month in micro-USD, or null when the plan pays for usage. */
  monthlyModelSpendCapMicroUsd: number | null;
}

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  /** Monthly list price in cents; 0 = free; null = custom (Talk to us). */
  monthlyCents: number | null;
  limits: PlanLimits;
  features: PlanFeature[];
  cta: { label: string; href: string };
  highlighted?: boolean;
  support: string;
}

export const PLANS: Record<PlanId, Plan> = {
  developer: {
    id: "developer",
    name: "Developer",
    tagline: "Kick the tyres on a sample world.",
    monthlyCents: 0,
    limits: { environments: 1, trialsPerMonth: 50, overageAllowed: false, monthlyModelSpendCapMicroUsd: FREE_MONTHLY_MODEL_SPEND_CAP_MICRO_USD },
    features: [
      { label: "1 environment" },
      { label: "50 trials / month" },
      { label: "Sample worlds (support, ops, fintech)" },
      { label: "MCP server + REST API" },
      { label: "Community support" },
    ],
    cta: { label: "Start free", href: "/sandbox" },
    support: "Community",
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "For teams shipping one serious agent.",
    monthlyCents: 49_900,
    limits: { environments: 3, trialsPerMonth: 2_500, overageAllowed: true, monthlyModelSpendCapMicroUsd: null },
    features: [
      { label: "3 custom environments" },
      { label: "2,500 trials / month" },
      { label: "pass^k reports with confidence intervals" },
      { label: "CI (GitHub Action) + MCP" },
      { label: "Voice + vision scenarios" },
      { label: "Email support" },
    ],
    cta: { label: "Start Pro", href: "/pricing?checkout=pro" },
    highlighted: true,
    support: "Email",
  },
  scale: {
    id: "scale",
    name: "Scale",
    tagline: "For agents that run real money and real customers.",
    monthlyCents: 249_900,
    limits: { environments: 15, trialsPerMonth: 25_000, overageAllowed: true, monthlyModelSpendCapMicroUsd: null },
    features: [
      { label: "15 environments" },
      { label: "25,000 trials / month" },
      { label: "Red-team packs" },
      { label: "Dedicated Neon project", comingSoon: true },
      { label: "Priority runs" },
      { label: "Slack support", comingSoon: true },
    ],
    cta: { label: "Start Scale", href: "/pricing?checkout=scale" },
    support: "Slack (coming soon); email today",
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    tagline: "We build your agent's world with you.",
    monthlyCents: null,
    limits: { environments: null, trialsPerMonth: null, overageAllowed: true, monthlyModelSpendCapMicroUsd: null },
    features: [
      { label: "We build your environment from your APIs, data and policies" },
      { label: "Domain-expert reviewers" },
      { label: "Volume pricing" },
      { label: "Security review", comingSoon: true },
    ],
    cta: { label: "Talk to us", href: "/contact-sales" },
    support: "Named contact",
  },
};

export const PLAN_ORDER: readonly PlanId[] = PLAN_IDS;

/** One-off Agent Audit: a custom sandbox of your agent's world, 500+ trials, failure clustering, fixes, report in 72h. */
export const AGENT_AUDIT = {
  id: "agent_audit",
  name: "Agent Audit",
  priceCents: 250_000,
  minTrials: 500,
  turnaroundHours: 72,
  features: [
    "Custom sandbox of your agent's world",
    "500+ trials across your real workflows",
    "Failure clustering",
    "Fix recommendations",
    "Report in 72 hours",
  ],
} as const;

/** Stripe price lookup keys (created idempotently by scripts/stripe-setup.ts). */
export const STRIPE_LOOKUP_KEYS = {
  pro_month: "se_pro_monthly_v1",
  pro_year: "se_pro_annual_v1",
  scale_month: "se_scale_monthly_v1",
  scale_year: "se_scale_annual_v1",
  agent_audit: "se_agent_audit_v1",
} as const;
export type StripeLookupKey = (typeof STRIPE_LOOKUP_KEYS)[keyof typeof STRIPE_LOOKUP_KEYS];

export function isPlanId(v: unknown): v is PlanId {
  return typeof v === "string" && (PLAN_IDS as readonly string[]).includes(v);
}
export function isSelfServePlanId(v: unknown): v is SelfServePlanId {
  return typeof v === "string" && (SELF_SERVE_PLAN_IDS as readonly string[]).includes(v);
}
export function isBillingInterval(v: unknown): v is BillingInterval {
  return typeof v === "string" && (BILLING_INTERVALS as readonly string[]).includes(v);
}

/** Price charged per billing period in cents (annual = 10x monthly). */
export function planPriceCents(plan: SelfServePlanId, interval: BillingInterval): number {
  const monthly = PLANS[plan].monthlyCents!;
  return interval === "year" ? monthly * ANNUAL_MONTHS_BILLED : monthly;
}

/** Effective monthly price when billed annually, in cents (rounded down to whole cents). */
export function effectiveMonthlyCents(plan: SelfServePlanId, interval: BillingInterval): number {
  return interval === "year" ? Math.floor(planPriceCents(plan, "year") / 12) : planPriceCents(plan, "month");
}

export function lookupKeyFor(plan: SelfServePlanId, interval: BillingInterval): StripeLookupKey {
  return STRIPE_LOOKUP_KEYS[`${plan}_${interval}`];
}

/** Resolve a lookup key back to what it sells (used when reading Stripe objects). */
export function productForLookupKey(key: string):
  | { kind: "plan"; plan: SelfServePlanId; interval: BillingInterval }
  | { kind: "audit" }
  | null {
  if (key === STRIPE_LOOKUP_KEYS.agent_audit) return { kind: "audit" };
  for (const plan of SELF_SERVE_PLAN_IDS) {
    for (const interval of BILLING_INTERVALS) {
      if (lookupKeyFor(plan, interval) === key) return { kind: "plan", plan, interval };
    }
  }
  return null;
}

export function planLimits(plan: PlanId): PlanLimits {
  return PLANS[plan].limits;
}

/** Overage charge in cents for a month's trial count. Free plan never accrues overage (it is hard-stopped). */
export function overageCents(plan: PlanId, trialsUsed: number): number {
  const { trialsPerMonth, overageAllowed } = PLANS[plan].limits;
  if (!overageAllowed || trialsPerMonth == null) return 0;
  return Math.max(0, Math.floor(trialsUsed) - trialsPerMonth) * OVERAGE_CENTS_PER_TRIAL;
}

export type TrialAllowance =
  | { ok: true; includedRemaining: number; overageTrials: number }
  | { ok: false; reason: string };

/** May `requested` more trials start this month given `used` so far? Paid plans may exceed (overage); free may not. */
export function checkTrialAllowance(plan: PlanId, used: number, requested: number): TrialAllowance {
  const { trialsPerMonth, overageAllowed } = PLANS[plan].limits;
  if (trialsPerMonth == null) return { ok: true, includedRemaining: Number.POSITIVE_INFINITY, overageTrials: 0 };
  const includedRemaining = Math.max(0, trialsPerMonth - used);
  if (requested <= includedRemaining) return { ok: true, includedRemaining, overageTrials: 0 };
  if (!overageAllowed) {
    return {
      ok: false,
      reason: `The ${PLANS[plan].name} plan includes ${trialsPerMonth} trials per month; ${includedRemaining} left and this run needs ${requested}. Upgrade to Pro for 2,500 trials per month.`,
    };
  }
  return { ok: true, includedRemaining, overageTrials: requested - includedRemaining };
}

/** May the account create another environment? */
export function checkEnvironmentAllowance(plan: PlanId, existing: number): { ok: true } | { ok: false; reason: string } {
  const max = PLANS[plan].limits.environments;
  if (max == null || existing < max) return { ok: true };
  return { ok: false, reason: `The ${PLANS[plan].name} plan includes ${max} environment${max === 1 ? "" : "s"}. Upgrade for more.` };
}

/** Display helper: 49900 -> "$499", 20 -> "$0.20". */
export function formatUsd(cents: number): string {
  const whole = cents % 100 === 0;
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** Start of the current UTC calendar month (usage window for trials and free-plan spend). */
export function usageWindowStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

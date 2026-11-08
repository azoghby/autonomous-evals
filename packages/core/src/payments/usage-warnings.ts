import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { isOperator } from "../auth/tokens";
import { PLANS, type PlanId } from "../pricing/plans";
import { effectivePlanFor } from "./plans-checkout";

/** Percent-of-allowance thresholds that trigger a warning email, lowest first. */
export const USAGE_WARNING_THRESHOLDS = [80, 100] as const;
export type UsageWarningThreshold = (typeof USAGE_WARNING_THRESHOLDS)[number];

export interface WarnableCustomer {
  id: string;
  email: string;
  name: string | null;
  plan: string;
  planStatus: string | null;
}

export interface UsageWarningClaim {
  customerId: string;
  periodStart: Date;
  threshold: number;
  plan: PlanId;
  trialsUsed: number;
  includedTrials: number;
  status: "sent" | "skipped";
}

export interface UsageWarningDeps {
  /** Non-fixture customers that ran sandbox trials in [start, end), with that count. */
  listActiveCustomers(start: Date, end: Date): Promise<Array<{ customer: WarnableCustomer; trialsUsed: number }>>;
  /** Insert the marker; false when it already exists (already handled this month). */
  claim(row: UsageWarningClaim): Promise<boolean>;
  /** Remove a marker after a failed send so the next run retries. */
  release(customerId: string, periodStart: Date, threshold: number): Promise<void>;
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
  /** False when no email transport is configured: nothing is claimed or sent. */
  canSend(): boolean;
}

export interface UsageWarningSummary {
  period: string;
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/** Highest threshold crossed by `used` of `included`, or null. Plans without a numeric allowance never warn. */
export function crossedThreshold(used: number, included: number | null): UsageWarningThreshold | null {
  if (included == null || included <= 0) return null;
  const pct = (Math.max(0, used) / included) * 100;
  let hit: UsageWarningThreshold | null = null;
  for (const t of USAGE_WARNING_THRESHOLDS) if (pct >= t) hit = t;
  return hit;
}

const nf = new Intl.NumberFormat("en-US");

/** Plain-text transactional email to the account owner about their own plan usage. */
export function usageWarningEmail(a: {
  name: string | null; plan: PlanId; threshold: UsageWarningThreshold; used: number; included: number; origin: string; resetsOn: string;
}): { subject: string; text: string } {
  const planName = PLANS[a.plan].name;
  const billing = `${a.origin}/settings/billing`;
  const hard = !PLANS[a.plan].limits.overageAllowed;
  const head = a.threshold === 100
    ? `You have used all ${nf.format(a.included)} included trials on your ${planName} plan this month.`
    : `You have used ${nf.format(a.used)} of your ${nf.format(a.included)} included trials (80%) on your ${planName} plan this month.`;
  const next = a.threshold === 100
    ? hard
      ? "New runs are paused until your allowance resets, or you can upgrade to keep going."
      : "Runs keep working. Trials beyond your allowance are billed as overage at $0.20 each at the end of the month."
    : hard
      ? "When you reach the limit, new runs pause until your allowance resets. Upgrade any time to avoid that."
      : "Runs keep working past the limit; extra trials are billed as overage at $0.20 each.";
  const text = [
    `Hi${a.name ? ` ${a.name}` : ""},`,
    "",
    head,
    next,
    "",
    `See usage and change your plan: ${billing}`,
    `Your allowance resets on ${a.resetsOn} (UTC).`,
    "",
    "Standard Evals",
    "You are getting this because you have a Standard Evals account. It is a one-time usage notice, not marketing.",
  ].join("\n");
  const subject = a.threshold === 100
    ? `You have used all included trials on ${planName}`
    : `You have used 80% of your ${planName} trials this month`;
  return { subject, text };
}

/**
 * Sends the highest newly crossed usage warning (80% or 100%) once per customer per UTC month per threshold.
 * A lower threshold crossed in the same run as a higher one is recorded as skipped so it never fires late.
 */
export async function sendUsageWarnings(
  args: { now?: Date; origin: string }, deps: UsageWarningDeps,
): Promise<UsageWarningSummary> {
  const now = args.now ?? new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const summary: UsageWarningSummary = { period: start.toISOString().slice(0, 7), considered: 0, sent: 0, skipped: 0, failed: 0, errors: [] };
  if (!deps.canSend()) return summary;
  const resetsOn = end.toISOString().slice(0, 10);

  for (const { customer, trialsUsed } of await deps.listActiveCustomers(start, end)) {
    summary.considered++;
    try {
      const plan = effectivePlanFor({ plan: customer.plan, planStatus: customer.planStatus });
      const included = PLANS[plan].limits.trialsPerMonth;
      const top = crossedThreshold(trialsUsed, included);
      if (top == null || included == null) { summary.skipped++; continue; }
      const base = { customerId: customer.id, periodStart: start, plan, trialsUsed, includedTrials: included };
      for (const lower of USAGE_WARNING_THRESHOLDS.filter((t) => t < top)) await deps.claim({ ...base, threshold: lower, status: "skipped" });
      if (!(await deps.claim({ ...base, threshold: top, status: "sent" }))) { summary.skipped++; continue; }
      const mail = usageWarningEmail({ name: customer.name, plan, threshold: top, used: trialsUsed, included, origin: args.origin, resetsOn });
      try {
        await deps.send({ to: customer.email, ...mail });
        summary.sent++;
      } catch (err) {
        await deps.release(customer.id, start, top).catch(() => undefined);
        throw err;
      }
    } catch (err) {
      summary.failed++;
      summary.errors.push(`${customer.id}: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }
  }
  return summary;
}

/** Drizzle + email implementation. Mail goes to the account owner's own address via the AgentMail sender. */
export function createDbUsageWarningDeps(): UsageWarningDeps {
  const W = schema.usageWarnings;
  return {
    async listActiveCustomers(start, end) {
      const C = schema.customers;
      const R = schema.sandboxRuns;
      const rows = await db().select({
        id: C.id, email: C.email, name: C.name, plan: C.plan, planStatus: C.planStatus,
        trials: sql<number>`coalesce(sum(case when ${R.status} = 'failed' then ${R.trialsDone} else ${R.trialsTotal} end), 0)::int`,
      }).from(R).innerJoin(C, eq(C.id, R.ownerId))
        .where(and(eq(C.isInternalFixture, false), isNotNull(C.email), gte(R.createdAt, start), lt(R.createdAt, end)))
        .groupBy(C.id, C.email, C.name, C.plan, C.planStatus);
      return rows
        .filter((r) => !isOperator(r.email))
        .map((r) => ({
          customer: { id: r.id, email: r.email, name: r.name, plan: r.plan, planStatus: r.planStatus },
          trialsUsed: Number(r.trials),
        }));
    },
    async claim(row) {
      const inserted = await db().insert(W).values(row).onConflictDoNothing().returning({ id: W.id });
      return inserted.length > 0;
    },
    async release(customerId, periodStart, threshold) {
      await db().delete(W).where(and(eq(W.customerId, customerId), eq(W.periodStart, periodStart), eq(W.threshold, threshold)));
    },
    async send(msg) {
      const { sendEmail } = await import("../auth/email");
      await sendEmail({ ...msg, purpose: "commercial", labels: ["usage-warning"] });
    },
    canSend: () => !!process.env.AGENTMAIL_API_KEY,
  };
}

import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { PLANS, OVERAGE_CENTS_PER_TRIAL, formatUsd, type PlanId } from "../pricing/plans";
import { computeOverage, overageIdempotencyKey, periodLabel, type OverageQuote, type UsagePeriod } from "../pricing/overage";
import { isOperator } from "../auth/tokens";
import { effectivePlanFor } from "./plans-checkout";
import { getStripeMode, stripe, type StripeMode } from "./stripe";

export interface BillableCustomer {
  id: string;
  email: string | null;
  plan: string;
  planStatus: string | null;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
}

/**
 * Subscription states that owe overage. Trialing customers are not billed (the trial is free), and canceled/incomplete
 * subscriptions have nothing to attach an invoice item to. past_due is still a live subscription in Stripe.
 */
export const OVERAGE_BILLABLE_STATUSES: ReadonlySet<string> = new Set(["active", "past_due"]);

export interface OverageRow {
  customerId: string;
  periodStart: Date;
  periodEnd: Date;
  plan: PlanId;
  trialsUsed: number;
  includedTrials: number;
  overageTrials: number;
  amountCents: number;
  environment: StripeMode;
}

export interface StoredOverageRow extends OverageRow {
  id: string;
  status: "pending" | "billed" | "failed";
  stripeInvoiceItemId: string | null;
}

export interface InvoiceItemInput {
  stripeCustomerId: string;
  amountCents: number;
  description: string;
  metadata: Record<string, string>;
  idempotencyKey: string;
}

export interface OverageDeps {
  /** Customers with a Stripe customer id, excluding internal fixtures. */
  listBillableCustomers(): Promise<BillableCustomer[]>;
  /** Trials used in [start, end), using the sandbox usage counting rule. */
  trialsUsed(customerId: string, start: Date, end: Date): Promise<number>;
  /** Insert-on-conflict-do-nothing, then return the existing row for (customer, periodStart). */
  claim(row: OverageRow): Promise<{ row: StoredOverageRow; claimed: boolean }>;
  markBilled(id: string, invoiceItemId: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  createInvoiceItem(input: InvoiceItemInput): Promise<{ id: string }>;
  /**
   * An overage invoice item already in Stripe for this customer and period (pending or invoiced), matched on metadata.
   * Guards retries after the Stripe idempotency key (24h) has expired.
   */
  findExistingInvoiceItem(input: { stripeCustomerId: string; customerId: string; period: string; createdAfter: Date }): Promise<{ id: string } | null>;
}

export interface OverageFailure {
  customerId: string;
  error: string;
}

export interface OverageSummary {
  period: string;
  considered: number;
  billed: number;
  skipped: number;
  failed: number;
  totalCents: number;
  failures: OverageFailure[];
}

/** Dashboard helper: what the current month's usage would cost in overage right now. */
export function currentPeriodOverageEstimate(plan: PlanId, trialsUsed: number): OverageQuote {
  return computeOverage({ plan, trialsUsed });
}

function monthName(start: Date): string {
  return start.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function describeOverage(row: OverageRow): string {
  return `Trial overage ${monthName(row.periodStart)}: ${row.overageTrials} trials x ${formatUsd(OVERAGE_CENTS_PER_TRIAL)}`;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

type Outcome = { kind: "billed"; cents: number } | { kind: "skipped" } | { kind: "failed"; error: string };

/** Only paying subscribers: no trials, no lapsed subscriptions, no operators (matches the usage-warnings path). */
export function isOverageBillable(c: BillableCustomer): boolean {
  if (c.email && isOperator(c.email)) return false;
  if (!c.stripeSubscriptionId) return false;
  return c.planStatus !== null && OVERAGE_BILLABLE_STATUSES.has(c.planStatus);
}

async function billCustomer(c: BillableCustomer, period: UsagePeriod, deps: OverageDeps, environment: StripeMode): Promise<Outcome> {
  if (!isOverageBillable(c)) return { kind: "skipped" };
  const plan = effectivePlanFor({ plan: c.plan, planStatus: c.planStatus });
  if (!PLANS[plan].limits.overageAllowed) return { kind: "skipped" };
  const used = await deps.trialsUsed(c.id, period.start, period.end);
  const quote = computeOverage({ plan, trialsUsed: used });
  if (quote.amountCents <= 0) return { kind: "skipped" };

  const { row } = await deps.claim({
    customerId: c.id, periodStart: period.start, periodEnd: period.end, plan, trialsUsed: used, ...quote, environment,
  });
  if (row.status === "billed") return { kind: "skipped" };

  // Retries reuse the stored row so the Stripe request body matches the original idempotent call.
  try {
    // The idempotency key expires after 24h and the row is only marked billed after Stripe succeeds, so a crash between
    // the two would double bill on a later retry. Look for the item in Stripe first.
    const existing = await deps.findExistingInvoiceItem({
      stripeCustomerId: c.stripeCustomerId, customerId: c.id, period: periodLabel(period.start), createdAfter: period.end,
    });
    if (existing) {
      await deps.markBilled(row.id, existing.id);
      return { kind: "billed", cents: row.amountCents };
    }
    const item = await deps.createInvoiceItem({
      stripeCustomerId: c.stripeCustomerId,
      amountCents: row.amountCents,
      description: describeOverage(row),
      metadata: { kind: "overage", customer_id: c.id, period: periodLabel(period.start), environment: row.environment },
      idempotencyKey: overageIdempotencyKey(c.id, period.start),
    });
    await deps.markBilled(row.id, item.id);
    return { kind: "billed", cents: row.amountCents };
  } catch (err) {
    const error = errorText(err);
    await deps.markFailed(row.id, error).catch((e) => console.error("overage markFailed failed", c.id, errorText(e)));
    return { kind: "failed", error };
  }
}

/**
 * Bills one usage period's overage as pending Stripe invoice items (picked up by each customer's next subscription
 * invoice). Idempotent: billed rows are skipped; pending/failed rows retry with the same Stripe idempotency key.
 * One customer's failure never stops the others.
 */
export async function billOverageForPeriod(
  args: { period: UsagePeriod; now?: Date },
  deps: OverageDeps,
  environment: StripeMode = getStripeMode(),
): Promise<OverageSummary> {
  const customers = await deps.listBillableCustomers();
  const counts = { billed: 0, skipped: 0, failed: 0, totalCents: 0 };
  const failures: OverageFailure[] = [];
  for (const c of customers) {
    let outcome: Outcome;
    try {
      outcome = await billCustomer(c, args.period, deps, environment);
    } catch (err) {
      outcome = { kind: "failed", error: errorText(err) };
    }
    if (outcome.kind === "billed") { counts.billed++; counts.totalCents += outcome.cents; }
    else if (outcome.kind === "skipped") counts.skipped++;
    else { counts.failed++; failures.push({ customerId: c.id, error: outcome.error }); }
  }
  return { period: periodLabel(args.period.start), considered: customers.length, ...counts, failures };
}

/** Drizzle + Stripe implementation. Stripe mode is enforced by stripe() (key must match STRIPE_MODE). */
export function createDbOverageDeps(): OverageDeps {
  const O = schema.overageCharges;
  return {
    async listBillableCustomers() {
      const C = schema.customers;
      const rows = await db().select({
        id: C.id, email: C.email, plan: C.plan, planStatus: C.planStatus,
        stripeCustomerId: C.stripeCustomerId, stripeSubscriptionId: C.stripeSubscriptionId,
      }).from(C).where(and(
        eq(C.isInternalFixture, false), isNotNull(C.stripeCustomerId), isNotNull(C.stripeSubscriptionId),
        inArray(C.planStatus, [...OVERAGE_BILLABLE_STATUSES]),
      ));
      return rows.flatMap((r) => (r.stripeCustomerId ? [{ ...r, stripeCustomerId: r.stripeCustomerId }] : []));
    },
    async trialsUsed(customerId, start, end) {
      const R = schema.sandboxRuns;
      const [r] = await db().select({
        trials: sql<number>`coalesce(sum(case when ${R.status} = 'failed' then ${R.trialsDone} else ${R.trialsTotal} end), 0)::int`,
      }).from(R).where(and(eq(R.ownerId, customerId), gte(R.createdAt, start), lt(R.createdAt, end)));
      return Number(r?.trials ?? 0);
    },
    async claim(row) {
      const inserted = await db().insert(O).values(row).onConflictDoNothing().returning();
      const [existing] = inserted.length > 0 ? inserted
        : await db().select().from(O).where(and(eq(O.customerId, row.customerId), eq(O.periodStart, row.periodStart))).limit(1);
      if (!existing) throw new Error("overage claim row missing after insert");
      return {
        claimed: inserted.length > 0,
        row: { ...existing, plan: existing.plan as PlanId, status: existing.status as StoredOverageRow["status"] },
      };
    },
    async markBilled(id, invoiceItemId) {
      await db().update(O).set({ status: "billed", stripeInvoiceItemId: invoiceItemId, error: null, billedAt: new Date() }).where(eq(O.id, id));
    },
    async markFailed(id, error) {
      await db().update(O).set({ status: "failed", error }).where(eq(O.id, id));
    },
    async createInvoiceItem(i) {
      const item = await stripe().invoiceItems.create({
        customer: i.stripeCustomerId, amount: i.amountCents, currency: "usd", description: i.description, metadata: i.metadata,
      }, { idempotencyKey: i.idempotencyKey });
      return { id: item.id };
    },
    async findExistingInvoiceItem({ stripeCustomerId, customerId, period, createdAfter }) {
      const items = stripe().invoiceItems.list({
        customer: stripeCustomerId, created: { gte: Math.floor(createdAfter.getTime() / 1000) }, limit: 100,
      });
      for await (const item of items) {
        const m = item.metadata ?? {};
        if (m.kind === "overage" && m.customer_id === customerId && m.period === period) return { id: item.id };
      }
      return null;
    },
  };
}

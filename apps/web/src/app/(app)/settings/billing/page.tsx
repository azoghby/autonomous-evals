import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db, schema } from "@ae/core/db/client";
import { getStripeMode } from "@ae/core/payments/stripe";
import { OVERAGE_CENTS_PER_TRIAL, PLANS, formatUsd } from "@ae/core/pricing/plans";
import { Eyebrow } from "@/components/ui";
import { getCurrentCustomer } from "@/server/queries";
import { getUsageSummary, overageNotice } from "@/server/billing-usage";
import { ManageBillingButton } from "@/components/billing/ManageBillingButton";
import { UpgradeCard } from "@/components/billing/UpgradeCard";
import { UsageMeter } from "@/components/billing/UsageMeter";

export const metadata: Metadata = { title: "Billing and usage · Standard Evals" };
export const dynamic = "force-dynamic";

const fmt = new Intl.NumberFormat("en-US");
const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`;
const STATUS_LABEL: Record<string, string> = {
  ok: "Within limits", near_limit: "Near a limit", at_limit: "At a limit",
};

function safeStripeMode(): "test" | "live" | null {
  try { return getStripeMode(); } catch { return null; }
}

export default async function BillingPage() {
  const me = await getCurrentCustomer();
  if (!me) redirect("/signin?next=/settings/billing");

  const [summary, [row]] = await Promise.all([
    getUsageSummary(me.id),
    db().select({
      planInterval: schema.customers.planInterval,
      planStatus: schema.customers.planStatus,
      planCurrentPeriodEnd: schema.customers.planCurrentPeriodEnd,
      stripeCustomerId: schema.customers.stripeCustomerId,
    }).from(schema.customers).where(eq(schema.customers.id, me.id)).limit(1),
  ]);
  const paid = summary.plan !== "developer";
  const mode = safeStripeMode();
  const plan = PLANS[summary.plan];
  const { trials, environments, modelSpend } = summary;
  const renewal = row?.planCurrentPeriodEnd ? dateFmt.format(row.planCurrentPeriodEnd) : null;

  return (
    <div className="bill-page min-w-0 py-10 sm:py-14">
      <header className="mb-8 max-w-3xl">
        <Eyebrow>Settings</Eyebrow>
        <h1 className="t-h1 mt-3 text-fg">Billing and usage</h1>
        <p className="t-lead mt-3 text-muted">Your plan, this month&apos;s usage and how to change either.</p>
        {mode === "test" && (
          <p className="bill-testmode mt-4"><span aria-hidden="true" className="bill-dot" /> Stripe test mode: no real charges are made.</p>
        )}
      </header>

      <div className="bill-grid">
        <div className="bill-main">
          <section className="bill-card" aria-labelledby="bill-plan-h">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="bill-kicker">Current plan</p>
                <h2 id="bill-plan-h" className="bill-plan-name">{plan.name}</h2>
                <p className="mt-1 text-[14px] text-muted">
                  {plan.monthlyCents == null ? "Custom pricing" : plan.monthlyCents === 0 ? "Free" : `${formatUsd(plan.monthlyCents)} / month list price`}
                  {row?.planInterval ? ` · billed ${row.planInterval === "year" ? "annually" : "monthly"}` : ""}
                </p>
              </div>
              <span className="bill-pill" data-state={summary.status}>{STATUS_LABEL[summary.status]}</span>
            </div>
            <dl className="bill-facts">
              {paid && row?.planStatus ? (<div><dt>Subscription</dt><dd className="capitalize">{row.planStatus.replace(/_/g, " ")}</dd></div>) : null}
              {renewal ? (<div><dt>{row?.planStatus === "canceled" ? "Ends" : "Renews"}</dt><dd>{renewal}</dd></div>) : null}
              <div><dt>Usage resets</dt><dd>{dateFmt.format(new Date(summary.resetsAt))}</dd></div>
            </dl>
            <div className="mt-5 flex flex-wrap items-start gap-3">
              {row?.stripeCustomerId ? <ManageBillingButton /> : null}
              {!row?.stripeCustomerId && summary.plan === "developer" ? (
                <a className="text-[14px] underline" href="/pricing">Choose a plan to add billing</a>
              ) : null}
            </div>
          </section>

          <section className="bill-card" aria-labelledby="bill-usage-h">
            <p className="bill-kicker">This month</p>
            <h2 id="bill-usage-h" className="sr-only">Usage this month</h2>
            <div className="mt-3 space-y-6">
              <UsageMeter
                label="Trials"
                used={fmt.format(trials.used)}
                limit={trials.included == null ? null : fmt.format(trials.included)}
                ratio={trials.included ? trials.used / trials.included : 0}
                note={trials.included != null && trials.used >= trials.included && paid ? overageNotice() : undefined}
              />
              <UsageMeter
                label="Environments"
                used={fmt.format(environments.used)}
                limit={environments.max == null ? null : fmt.format(environments.max)}
                ratio={environments.max ? environments.used / environments.max : 0}
              />
              {modelSpend.capMicroUsd != null ? (
                <UsageMeter
                  label="Model spend (free cap)"
                  used={usd(modelSpend.usedMicroUsd)}
                  limit={usd(modelSpend.capMicroUsd)}
                  ratio={modelSpend.usedMicroUsd / modelSpend.capMicroUsd}
                  note="Runs stop when the free plan's monthly model spend cap is reached."
                />
              ) : null}
            </div>
          </section>

          {paid ? (
            <section className="bill-card" aria-labelledby="bill-overage-h">
              <p className="bill-kicker">Projected overage</p>
              <h2 id="bill-overage-h" className="bill-overage">{formatUsd(summary.projectedOverageCents)}</h2>
              <p className="mt-2 text-[14px] text-muted">
                Trials beyond your included allowance cost {formatUsd(OVERAGE_CENTS_PER_TRIAL)} each. Overage is billed automatically to your card at the end of the month.
              </p>
            </section>
          ) : null}
        </div>

        {summary.upgrade ? (
          <aside className="bill-side"><UpgradeCard targetPlan={summary.upgrade.targetPlan} reason={summary.upgrade.reason} /></aside>
        ) : null}
      </div>
    </div>
  );
}

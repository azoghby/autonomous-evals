"use client";
import { useState } from "react";
import { Button } from "@/components/ui";
import { CheckoutButton } from "@/app/pricing/CheckoutButton";
import {
  ANNUAL_MONTHS_BILLED, PLANS, formatUsd, planPriceCents, type BillingInterval, type PlanId,
} from "@ae/core/pricing/plans";

interface UpgradeCardProps {
  targetPlan: PlanId;
  reason: string;
}

/** Upgrade call-to-action: monthly/annual choice for Pro and Scale, contact-sales link for Enterprise. */
export function UpgradeCard({ targetPlan, reason }: UpgradeCardProps) {
  const [interval, setInterval] = useState<BillingInterval>("month");
  const plan = PLANS[targetPlan];

  return (
    <section className="bill-upgrade" aria-labelledby="bill-upgrade-h">
      <p className="bill-kicker">Upgrade</p>
      <h2 id="bill-upgrade-h" className="t-h3 mt-1 text-fg">Move to {plan.name}</h2>
      <p className="mt-2 text-[14px] text-fg-2">{reason}</p>
      {targetPlan === "enterprise" ? (
        <div className="mt-5"><Button href="/contact-sales">Talk to us</Button></div>
      ) : (
        <>
          <div role="radiogroup" aria-label="Billing interval" className="bill-toggle mt-5">
            <button type="button" role="radio" aria-checked={interval === "month"} onClick={() => setInterval("month")}>Monthly</button>
            <button type="button" role="radio" aria-checked={interval === "year"} onClick={() => setInterval("year")}>
              Annual <span className="bill-free">2 months free</span>
            </button>
          </div>
          {(targetPlan === "pro" || targetPlan === "scale") && (
            <>
              <p className="mt-4 font-mono text-[28px] leading-none text-fg">
                {formatUsd(planPriceCents(targetPlan, interval))}
                <span className="ml-1 text-[13px] text-muted">/ {interval === "year" ? `year (${ANNUAL_MONTHS_BILLED} of 12 months)` : "month"}</span>
              </p>
              <div className="mt-5">
                <CheckoutButton request={{ kind: "plan", plan: targetPlan, interval }}>Upgrade to {plan.name}</CheckoutButton>
              </div>
            </>
          )}
        </>
      )}
      <p className="mt-4 text-[13px] text-muted">
        <a className="underline" href="/pricing">Compare all plans</a>
      </p>
    </section>
  );
}

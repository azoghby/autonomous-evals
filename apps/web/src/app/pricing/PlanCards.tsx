"use client";
import { useEffect, useRef, useState } from "react";
import {
  ANNUAL_MONTHS_BILLED, PLANS, PLAN_ORDER, effectiveMonthlyCents, formatUsd, planPriceCents,
  type BillingInterval, type PlanId, type SelfServePlanId,
} from "@ae/core/pricing/plans";
import { Button, NudgeArrow } from "@/components/ui";
import { CheckoutButton } from "./CheckoutButton";

const FREE_MONTHS = 12 - ANNUAL_MONTHS_BILLED;
const isSelfServe = (id: PlanId): id is SelfServePlanId => id === "pro" || id === "scale";

function Price({ id, interval }: { id: PlanId; interval: BillingInterval }) {
  const plan = PLANS[id];
  if (plan.monthlyCents == null) {
    return <div><span className="pr-price">Custom</span><p className="t-small mt-2 text-muted">Volume pricing</p></div>;
  }
  if (!isSelfServe(id)) {
    return <div><span className="pr-price">{formatUsd(0)}</span><p className="t-small mt-2 text-muted">Free forever, no card</p></div>;
  }
  const yearly = interval === "year";
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="pr-price">{formatUsd(effectiveMonthlyCents(id, interval))}</span>
        <span className="text-[14px] text-muted">/ month</span>
      </div>
      <p className="t-small mt-2 text-muted" aria-live="polite">
        {yearly ? `billed ${formatUsd(planPriceCents(id, "year"))} yearly` : "billed monthly"}
      </p>
    </div>
  );
}

function Cta({ id, interval }: { id: PlanId; interval: BillingInterval }) {
  const plan = PLANS[id];
  if (isSelfServe(id)) {
    return (
      <CheckoutButton request={{ kind: "plan", plan: id, interval }} variant={plan.highlighted ? "primary" : "outline"} size="lg" className="w-full">
        {plan.cta.label}
      </CheckoutButton>
    );
  }
  return (
    <Button href={plan.cta.href} variant="outline" size="lg" className="w-full">
      {plan.cta.label} <NudgeArrow />
    </Button>
  );
}

/** Interval toggle + the four plan cards. `focusPlan` (from ?checkout=pro|scale) scrolls to and rings that card; it never starts payment. */
export function PlanCards({ focusPlan }: { focusPlan?: SelfServePlanId }) {
  const [interval, setInterval] = useState<BillingInterval>("month");
  const refs = useRef<Partial<Record<PlanId, HTMLElement | null>>>({});

  useEffect(() => {
    if (!focusPlan) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    refs.current[focusPlan]?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
  }, [focusPlan]);

  return (
    <div>
      <div className="mb-12 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="pr-toggle" role="group" aria-label="Billing interval">
          <button type="button" aria-pressed={interval === "month"} onClick={() => setInterval("month")}>Monthly</button>
          <button type="button" aria-pressed={interval === "year"} onClick={() => setInterval("year")}>Annual</button>
        </div>
        <span className="font-mono text-[12px] uppercase text-accent-text">{FREE_MONTHS} months free on annual</span>
      </div>
      <ul className="grid list-none gap-x-6 gap-y-10 p-0 pt-3 md:grid-cols-2 xl:grid-cols-4">
        {PLAN_ORDER.map((id) => {
          const plan = PLANS[id];
          return (
            <li key={id} className="contents">
              <article
                id={`plan-${id}`}
                ref={(el) => { refs.current[id] = el; }}
                className="pr-card"
                data-highlight={plan.highlighted ? "true" : undefined}
                data-focused={focusPlan === id ? "true" : undefined}
                aria-labelledby={`plan-${id}-h`}
              >
                {plan.highlighted && <span className="pr-badge">Most teams start here</span>}
                <div>
                  <h3 id={`plan-${id}-h`} className="t-h3 text-fg">{plan.name}</h3>
                  <p className="mt-2 min-h-[2.9em] text-[14px] leading-snug text-muted">{plan.tagline}</p>
                </div>
                <Price id={id} interval={interval} />
                <Cta id={id} interval={interval} />
                <ul className="flex list-none flex-col gap-3 border-t border-line-2 p-0 pt-5">
                  {plan.features.map((f) => (
                    <li key={f.label} className="pr-feat">
                      <span>
                        {f.label}
                        {f.comingSoon && <sup className="pr-soon" title="Coming soon"><span aria-hidden>†</span><span className="sr-only"> (coming soon)</span></sup>}
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

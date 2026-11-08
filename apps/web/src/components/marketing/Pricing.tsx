import { PLANS, formatUsd, type PlanId } from "@ae/core/pricing/plans";
import { Button, NudgeArrow, Reveal, Section, cn } from "../ui";

const TEASER: readonly PlanId[] = ["developer", "pro", "scale"];

const nf = (n: number | null) => (n == null ? "Custom" : n.toLocaleString("en-US"));

export function Pricing() {
  return (
    <Section id="pricing" labelledBy="pricing-h" band className="scroll-mt-16">
      <div className="flex flex-col gap-12">
        <Reveal className="flex flex-col gap-4">
          <h2 id="pricing-h" className="t-h2 max-w-[22ch] text-balance text-fg">Priced per trial. <span className="text-muted">Not per token.</span></h2>
          <p className="t-lead max-w-[52ch]">Start free. Upgrade when your agent ships. Model tokens are passed through at cost.</p>
        </Reveal>
        <Reveal>
          <ul className="grid list-none gap-4 p-0 md:grid-cols-3">
            {TEASER.map((id) => {
              const p = PLANS[id];
              return (
                <li
                  key={id}
                  className={cn(
                    "flex flex-col gap-5 rounded-[4px] border p-6",
                    p.highlighted ? "border-accent bg-accent-soft" : "border-line-2 bg-bg",
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="t-h4 text-fg">{p.name}</h3>
                    {p.highlighted && <span className="font-mono text-[11px] uppercase text-accent-text">Most teams start here</span>}
                  </div>
                  <p className="font-mono text-[36px] leading-none tracking-[-0.04em] text-fg">
                    {formatUsd(p.monthlyCents ?? 0)}<span className="ml-1 text-[14px] tracking-normal text-muted">/ mo</span>
                  </p>
                  <ul className="flex list-none flex-col gap-2 border-t border-line-2 p-0 pt-4 text-[14px] text-fg-2">
                    <li>{nf(p.limits.trialsPerMonth)} trials / month</li>
                    <li>{nf(p.limits.environments)} environment{p.limits.environments === 1 ? "" : "s"}</li>
                    <li>{p.limits.overageAllowed ? "Overage billed per trial" : "Hard cap, never a surprise bill"}</li>
                  </ul>
                </li>
              );
            })}
          </ul>
        </Reveal>
        <Reveal className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <Button href="/pricing" variant="outline" className="group">See full pricing <NudgeArrow /></Button>
          <p className="text-[14px] text-muted">Enterprise and one-off Agent Audit available.</p>
        </Reveal>
      </div>
    </Section>
  );
}

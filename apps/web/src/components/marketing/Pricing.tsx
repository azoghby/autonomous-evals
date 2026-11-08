import { PER_FINDING_CENTS, PRICE_CENTS } from "@ae/core/contracts/index";
import { Button, NudgeArrow, Reveal, Section } from "../ui";

const usd = (c: number) => `$${c % 100 ? (c / 100).toFixed(2) : c / 100}`;

const PACKAGES = [
  ["Trace Audit", PRICE_CENTS.trace_audit],
  ["Text Eval", PRICE_CENTS.text_eval],
  ["Workflow Eval", PRICE_CENTS.workflow_eval],
  ["Version Comparison", PRICE_CENTS.version_comparison],
] as const;

export function Pricing() {
  return (
    <Section id="pricing" labelledBy="pricing-h" band className="scroll-mt-16">
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
        <Reveal className="flex flex-col gap-6 lg:col-span-5">
          <h2 id="pricing-h" className="t-h2 text-balance text-fg">Simple pricing. <span className="text-muted">Pilot rates, no contract.</span></h2>
          <p className="t-lead max-w-[30rem]">
            Pay a fixed price per eval, or {usd(PER_FINDING_CENTS)} per confirmed finding. Nothing confirmed, nothing owed.
          </p>
          <div><Button href="/start" variant="outline" className="group">Start an eval <NudgeArrow /></Button></div>
        </Reveal>
        <Reveal className="lg:col-span-7">
          <ul className="border-t border-line-2">
            {PACKAGES.map(([name, cents]) => (
              <li key={name} className="flex items-baseline justify-between gap-4 border-b border-line-2 py-5">
                <span className="text-[17px] text-fg">{name}</span>
                <span className="font-mono text-[17px] text-fg-2">{usd(cents)}</span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </Section>
  );
}

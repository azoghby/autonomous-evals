import { MONITORING_PRICE_CENTS_MONTHLY, PER_FINDING_CAP_CENTS, PER_FINDING_CENTS, PRICE_CENTS } from "@ae/core/contracts/index";
import { Button, NudgeArrow, Reveal, Section, SectionHeader } from "../ui";

const usd = (c: number) => `$${c % 100 ? (c / 100).toFixed(2) : c / 100}`;

const PACKAGES = [
  ["Trace Audit", PRICE_CENTS.trace_audit],
  ["Text Eval", PRICE_CENTS.text_eval],
  ["Workflow Eval", PRICE_CENTS.workflow_eval],
  ["Version Comparison", PRICE_CENTS.version_comparison],
] as const;
const CAPS = [
  ["Trace Audit", PER_FINDING_CAP_CENTS.trace_audit],
  ["Text Eval", PER_FINDING_CAP_CENTS.text_eval],
  ["Workflow Eval", PER_FINDING_CAP_CENTS.workflow_eval],
  ["Version Comparison", PER_FINDING_CAP_CENTS.version_comparison],
] as const;

function Row({ k, v }: { k: string; v: string }) {
  return (
    <li className="flex items-baseline gap-3 text-[15px] text-fg-2">
      <i aria-hidden className="size-1.5 shrink-0 translate-y-[-2px] bg-subtle" />
      <span className="flex-1">{k}</span>
      <span className="t-data text-fg">{v}</span>
    </li>
  );
}

const label = "font-mono text-[12px] uppercase text-fg-2";
const sep = "border-t border-dashed border-line-3 pt-6";

export function Pricing() {
  return (
    <Section id="pricing" labelledBy="pricing-h" className="scroll-mt-16">
      <Reveal>
        <SectionHeader
          id="pricing-h"
          index="04"
          eyebrow="Pricing"
          title={<>Pay a fixed price, or only for what we prove. <span className="text-muted">Pilot rates, no contract.</span></>}
        />
      </Reveal>
      <Reveal className="mt-14 md:mt-20">
        <div className="grid border border-line-2 md:grid-cols-2">
          <div className="flex flex-col gap-6 p-6 sm:p-8">
            <span className={label}>Fixed</span>
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] text-muted">from</span>
              <span className="font-mono text-[44px] leading-none tracking-[-0.04em] text-white">{usd(PACKAGES[0][1])}</span>
              <span className="text-[13px] text-muted">per eval</span>
            </div>
            <p className="t-small text-muted">One price per package. You know the bill before work starts.</p>
            <ul className={`flex flex-col gap-3 ${sep}`}>
              {PACKAGES.map(([n, c]) => <Row key={n} k={n} v={usd(c)} />)}
            </ul>
            <ul className={`flex flex-col gap-3 ${sep}`}>
              <Row k="Monitoring, nightly re-runs" v={`${usd(MONITORING_PRICE_CENTS_MONTHLY)}/mo`} />
            </ul>
            <div className="mt-auto pt-2">
              <Button href="/start" variant="outline" className="group">Get an eval <NudgeArrow /></Button>
            </div>
          </div>
          <div className="relative flex flex-col gap-6 border-t border-line-2 p-6 sm:p-8 md:border-l md:border-t-0">
            <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-accent md:-top-px" />
            <span className={label}>Per confirmed finding</span>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[44px] leading-none tracking-[-0.04em] text-white">{usd(PER_FINDING_CENTS)}</span>
              <span className="text-[13px] text-muted">per confirmed finding</span>
            </div>
            <p className="t-small text-muted">Nothing confirmed, nothing owed: $0. Charges stop at the package cap.</p>
            <ul className={`flex flex-col gap-3 ${sep}`}>
              {CAPS.map(([n, c]) => <Row key={n} k={`${n}, cap`} v={usd(c)} />)}
            </ul>
            <ul className={`flex flex-col gap-3 ${sep}`}>
              <Row k="Unconfirmed findings" v="$0" />
            </ul>
            <div className="mt-auto pt-2">
              <Button href="/start?pricing=per_finding" className="group">Get an eval <NudgeArrow /></Button>
            </div>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}

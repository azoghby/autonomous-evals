import type { Metadata } from "next";
import {
  AGENT_AUDIT, FREE_MONTHLY_MODEL_SPEND_CAP_MICRO_USD, MODEL_TOKEN_MARKUP_PERCENT, OVERAGE_CENTS_PER_TRIAL, PLANS,
  formatUsd, isSelfServePlanId,
} from "@ae/core/pricing/plans";
import { MONITORING_PRICE_CENTS_MONTHLY, PER_FINDING_CAP_CENTS, PER_FINDING_CENTS, PRICE_CENTS } from "@ae/core/contracts/index";
import { Button, Eyebrow, NudgeArrow, Reveal, Section, TopBar } from "@/components/ui";
import { Footer } from "@/components/marketing/Footer";
import { CheckoutButton } from "./CheckoutButton";
import { ComparisonTable } from "./ComparisonTable";
import { PlanCards } from "./PlanCards";
import { RoiCalculator } from "./RoiCalculator";
import "./pricing.css";

export const metadata: Metadata = {
  title: "Pricing · Standard Evals",
  description: "Priced per trial, not per token. Free to start, Pro and Scale plans, and a one-off Agent Audit. Model tokens are passed through at cost.",
};

// TopBar is a client module, so its DEFAULT_NAV value can't be read here; mirror it and add Pricing.
const NAV = [
  { label: "Demo", href: "/demo" },
  { label: "Sandbox", href: "/sandbox" },
  { label: "Leaderboard", href: "/leaderboard" },
  { label: "MCP", href: "/#mcp" },
  { label: "Pricing", href: "/pricing" },
];
const QUICK = [
  ["Trace Audit", "trace_audit"],
  ["Text Eval", "text_eval"],
  ["Workflow Eval", "workflow_eval"],
  ["Version Comparison", "version_comparison"],
] as const;

const overage = formatUsd(OVERAGE_CENTS_PER_TRIAL);
const freeCap = formatUsd(FREE_MONTHLY_MODEL_SPEND_CAP_MICRO_USD / 10_000);
const freePlan = PLANS.developer;

const FAQ: readonly [string, string][] = [
  ["What counts as a trial?", "One simulated user running one scenario end to end, in your copy of the world. It can be a long multi-turn conversation with many tool calls, large context, audio or images, and it is still one trial."],
  ["Are long, tool-heavy agents penalised?", `No. You pay per trial, not per token. A 40-turn workflow with 25 tool calls and 120k tokens of context is one trial. Model tokens your agent spends on our gateway are passed through at cost (${MODEL_TOKEN_MARKUP_PERCENT}% markup).`],
  ["Can I bring my own model key?", "Yes. With a bring-your-own key your agent's model calls go straight to your provider, so we charge you $0 in tokens. You only pay for trials."],
  ["What happens when I hit the free limit?", `Developer is hard-capped at ${freePlan.limits.trialsPerMonth} trials a month and ${freeCap} of our model spend. When you reach either, new runs stop. You are never charged.`],
  ["How does annual billing work?", "Annual plans are billed once a year for 10 months, so you get 2 months free. The monthly price shown is the effective rate."],
  ["Can I cancel anytime?", "Yes. Email us today and we will cancel at the end of your billing period. A self-serve Stripe customer portal is coming soon."],
  ["Can I still buy a single eval?", "Yes. Quick evals (Trace Audit, Text Eval, Workflow Eval, Version Comparison) are one-off purchases, no subscription. Start one from the Quick evals section below."],
  ["Do you have SOC 2 or HIPAA?", "We don't hold SOC 2 or HIPAA attestations today. An Enterprise security review is coming soon."],
];

const CHECKOUT_NOTICES = {
  cancelled: "Checkout cancelled. Nothing was charged.",
} as const;

export default async function PricingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const checkout = first(sp.checkout);
  const planParam = first(sp.plan);
  const focusPlan = isSelfServePlanId(checkout) ? checkout : undefined;
  const boughtPlan = checkout === "success" && planParam && planParam in PLANS ? PLANS[planParam as keyof typeof PLANS].name : null;

  return (
    <div className="bg-bg text-fg">
      <TopBar nav={NAV} active="/pricing" />
      <main id="main" tabIndex={-1} className="outline-none">
        <Section className="!pb-12 md:!pb-16 !pt-16 md:!pt-24" labelledBy="pricing-h">
          <div className="flex flex-col gap-6">
            <Eyebrow>Pricing</Eyebrow>
            <h1 id="pricing-h" className="t-h1 max-w-[18ch] text-balance">Priced per trial, <span className="text-muted">not per token.</span></h1>
            <p className="t-lead max-w-[56ch]">
              Staging for AI agents: a copy of your world, thousands of simulated users, graded on what actually changed.
            </p>
            <p><a href="#roi" className="text-[15px] text-accent-text underline underline-offset-4 hover:text-fg">What does an agent failure cost you? Estimate it</a></p>
            {checkout === "success" && (
              <p role="status" className="pr-banner max-w-[56ch]" data-tone="ok">
                {boughtPlan ? `You're on ${boughtPlan}. It can take a minute for limits to update.` : "Payment received. It can take a minute for limits to update."}
              </p>
            )}
            {checkout === "cancelled" && <p role="status" className="pr-banner max-w-[56ch] text-fg-2">{CHECKOUT_NOTICES.cancelled}</p>}
          </div>
        </Section>

        <Section id="plans" className="!pt-0 md:!pt-0 !pb-20">
          <PlanCards focusPlan={focusPlan} />
          <p className="t-small mt-10 max-w-[70ch] text-subtle">
            <span className="text-warn">†</span> Coming soon. Listed so you can see where the plan is going; not available today.
          </p>
        </Section>

        <Section id="roi" band labelledBy="roi-h">
          <div className="mb-10 flex flex-col gap-5 md:mb-14">
            <Eyebrow tone="muted">Cost of failure</Eyebrow>
            <h2 id="roi-h" className="t-h2 max-w-[24ch] text-balance">What does an agent failure cost you?</h2>
            <p className="t-lead max-w-[60ch]">Put in your own numbers. We estimate what failures cost you each month, and which plan covers the testing to catch them.</p>
          </div>
          <RoiCalculator />
        </Section>

        <Section labelledBy="audit-h">
          <Reveal className="grid gap-10 lg:grid-cols-12 lg:items-center">
            <div className="flex flex-col gap-4 lg:col-span-6">
              <Eyebrow tone="muted">One-off</Eyebrow>
              <h2 id="audit-h" className="t-h2 text-balance">{AGENT_AUDIT.name}</h2>
              <div className="flex items-baseline gap-3">
                <span className="pr-price">{formatUsd(AGENT_AUDIT.priceCents)}</span>
                <span className="text-muted">one-off, no subscription</span>
              </div>
              <p className="t-lead max-w-[44ch]">A custom sandbox of your agent&apos;s world, stress-tested and written up in {AGENT_AUDIT.turnaroundHours} hours.</p>
              <div className="mt-2"><CheckoutButton request={{ kind: "audit" }} size="lg">Book an audit</CheckoutButton></div>
            </div>
            <ul className="flex list-none flex-col gap-3 border-t border-line-2 p-0 lg:col-span-6 lg:border-l lg:border-t-0 lg:pl-10">
              {AGENT_AUDIT.features.map((f) => <li key={f} className="pr-feat !text-[16px] py-1.5">{f}</li>)}
            </ul>
          </Reveal>
        </Section>

        <Section labelledBy="compare-h">
          <h2 id="compare-h" className="t-h2 mb-10 text-balance">Compare plans</h2>
          <ComparisonTable />
        </Section>

        <Section band labelledBy="billing-h">
          <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
            <div className="flex flex-col gap-6 lg:col-span-6">
              <Eyebrow tone="muted">Billing</Eyebrow>
              <h2 id="billing-h" className="t-h2 text-balance">How billing works for long, tool-heavy agents</h2>
              <p className="t-lead">
                A trial is one simulated user running one scenario end to end. It can be a long multi-turn conversation with many tool calls, large context,
                audio or images, and it still counts as one trial.
              </p>
              <ul className="flex list-none flex-col gap-3 p-0 text-[15px] text-fg-2">
                <li className="pr-feat">You pay per trial. Heavy agents are not penalised by a per-token markup.</li>
                <li className="pr-feat">Model tokens your agent spends on our gateway are passed through at cost ({MODEL_TOKEN_MARKUP_PERCENT}% markup). Bring your own key and tokens from us are $0.</li>
                <li className="pr-feat">Overage is {overage} per trial beyond your plan, invoiced monthly.</li>
                <li className="pr-feat">Developer is hard-capped: no surprise bills. Our model spend on free accounts is capped at {freeCap} a month.</li>
              </ul>
            </div>
            <div className="lg:col-span-6">
              <figure className="rounded-[4px] border border-line-2 bg-bg-raised p-6 md:p-8">
                <figcaption className="t-eyebrow text-subtle">Worked example</figcaption>
                <p className="mt-4 text-[17px] leading-snug text-fg">A 40-turn support workflow, 25 tool calls, 120k tokens of context.</p>
                <dl className="mt-6 divide-y divide-line-2 border-y border-line-2 text-[15px]">
                  <div className="flex justify-between gap-4 py-3"><dt className="text-muted">Counts as</dt><dd className="font-mono text-fg">1 trial</dd></div>
                  <div className="flex justify-between gap-4 py-3"><dt className="text-muted">Within your plan</dt><dd className="font-mono text-fg">included</dd></div>
                  <div className="flex justify-between gap-4 py-3"><dt className="text-muted">Beyond your plan</dt><dd className="font-mono text-fg">{overage}</dd></div>
                  <div className="flex justify-between gap-4 py-3"><dt className="text-muted">Gateway tokens</dt><dd className="font-mono text-fg">at cost</dd></div>
                  <div className="flex justify-between gap-4 py-3"><dt className="text-muted">Your own key</dt><dd className="font-mono text-fg">$0 tokens</dd></div>
                </dl>
              </figure>
            </div>
          </div>
        </Section>

        <Section id="quick-evals" labelledBy="quick-h">
          <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
            <div className="flex flex-col gap-5 lg:col-span-5">
              <Eyebrow tone="muted">Pay per eval</Eyebrow>
              <h2 id="quick-h" className="t-h2 text-balance">Quick evals</h2>
              <p className="t-lead">One-off evals of a single trace, text, workflow or version, no subscription. Or pay per confirmed finding: {formatUsd(PER_FINDING_CENTS)} each, capped per eval. Nothing confirmed, nothing owed.</p>
              <div><Button href="/start" variant="outline" className="group">Start a quick eval <NudgeArrow /></Button></div>
            </div>
            <div className="lg:col-span-7">
              <div className="pr-table-wrap">
                <table className="pr-table" style={{ minWidth: 0 }}>
                  <caption className="sr-only">Quick eval prices</caption>
                  <thead>
                    <tr><th scope="col">Eval</th><th scope="col">Fixed price</th><th scope="col">Or per finding, capped at</th></tr>
                  </thead>
                  <tbody>
                    {QUICK.map(([name, key]) => (
                      <tr key={key}>
                        <th scope="row">{name}</th>
                        <td className="font-mono text-fg">{formatUsd(PRICE_CENTS[key])}</td>
                        <td className="font-mono">{formatUsd(PER_FINDING_CENTS)} each, up to {formatUsd(PER_FINDING_CAP_CENTS[key])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="t-small mt-4 text-muted">Monitoring add-on: <span className="font-mono text-fg-2">{formatUsd(MONITORING_PRICE_CENTS_MONTHLY)}/mo</span> to re-run an eval nightly.</p>
            </div>
          </div>
        </Section>

        <Section band labelledBy="faq-h">
          <div className="grid gap-10 lg:grid-cols-12 lg:gap-16">
            <h2 id="faq-h" className="t-h2 text-balance lg:col-span-4">Questions</h2>
            <div className="pr-faq lg:col-span-8">
              {FAQ.map(([q, a]) => (
                <details key={q}>
                  <summary>{q}</summary>
                  <p className="pr-answer">{a}</p>
                </details>
              ))}
            </div>
          </div>
        </Section>

        <section aria-label="Fine print" className="border-t border-line-2 bg-bg py-10">
          <div className="container-x t-small max-w-[80ch] space-y-2 text-subtle">
            <p><span className="text-warn">†</span> Coming soon: {Object.values(PLANS).flatMap((p) => p.features.filter((f) => f.comingSoon).map((f) => `${f.label} (${p.name})`)).join("; ")}.</p>
            <p>Prices are in USD; taxes may apply. Overage is invoiced monthly.</p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}

import { CircleCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Button, CountUp, DrawRule, NudgeArrow, Reveal, Stagger, StaggerItem, StatusChip, WaveGlyph } from "../ui";

function SectionHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <Reveal className="mb-14 max-w-2xl">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-navy/45">{eyebrow}</p>
      <h2 className="mt-3 text-balance text-4xl font-medium leading-[1.02] tracking-[-0.035em] text-navy sm:text-5xl">{title}</h2>
      {children && <p className="mt-4 text-lg text-navy/60">{children}</p>}
    </Reveal>
  );
}

const STEPS = [
  { t: "Submit", d: "Paste a transcript, or point us at an endpoint. Pick a package or let us choose." },
  { t: "Agent quote", d: "Our Commercial agent scopes the job and quotes from a fixed price table — in minutes." },
  { t: "Pay", d: "Checkout with Stripe. Work starts the moment payment clears; budgets are capped per job." },
  { t: "Report", d: "An evidence-backed report with reproducible findings. Re-run any finding on demand." },
] as const;

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-h" className="scroll-mt-6 px-5 py-28 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <SectionHead eyebrow="How it works" title="Four steps. No humans in the loop to wait on.">
          <span id="how-h" className="sr-only">How it works</span>
          Every stage is run by an agent with a budget and an audit trail.
        </SectionHead>
        <ol>
          {STEPS.map((s, i) => (
            <li key={s.t} className="text-navy/15">
              <DrawRule delay={i * 0.08} />
              <Reveal delay={i * 0.08} y={14} className="group grid grid-cols-[2.5rem_1fr] gap-x-4 gap-y-2 py-7 text-navy sm:grid-cols-[5rem_14rem_1fr] sm:items-baseline sm:gap-x-6 sm:py-8">
                <span className="font-mono text-sm text-navy/40">0{i + 1}</span>
                <h3 className="text-2xl font-medium tracking-tight transition-transform duration-300 ease-[var(--ease-out-expo)] group-hover:translate-x-1 motion-reduce:transform-none">{s.t}</h3>
                <p className="col-start-2 text-[15px] leading-relaxed text-navy/60 sm:col-start-3 sm:max-w-xl">{s.d}</p>
              </Reveal>
            </li>
          ))}
          <li aria-hidden className="text-navy/15"><DrawRule delay={0.4} /></li>
        </ol>
      </div>
    </section>
  );
}

const PRICES = [
  { n: "Trace Audit", in: "Paste or upload a transcript / tool logs (≤ 200 KB)", p: 5, u: "per eval" },
  { n: "Text Eval", in: "OpenAI-compatible endpoint + system prompt", p: 5, u: "per eval" },
  { n: "Workflow Eval", in: "Tool-calling endpoint, run in our calendar simulator", p: 5, u: "per eval" },
  { n: "Version Comparison", in: "Two configs of a Text or Workflow Eval", p: 10, u: "per comparison" },
  { n: "Monitoring", in: "Nightly re-run of your frozen suite, regression alerts", p: 49, u: "per month" },
] as const;

export function Pricing() {
  return (
    <section id="pricing" aria-labelledby="pricing-h" className="scroll-mt-6 border-t border-navy/10 px-5 py-28 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <SectionHead eyebrow="Pricing" title="Priced like a coffee, not a contract.">
          <span id="pricing-h" className="sr-only">Pricing</span>
          Pilot pricing — fixed prices, quoted by our agents, no sales call.
        </SectionHead>
        <Stagger id="services" className="scroll-mt-6 divide-y divide-navy/12 border-y border-navy/12">
          {PRICES.map((r) => (
            <StaggerItem key={r.n} y={12} className="group grid grid-cols-[1fr_auto] items-baseline gap-x-6 gap-y-1 py-6 sm:grid-cols-[14rem_1fr_auto]">
              <h3 className="text-xl font-medium tracking-tight text-navy transition-transform duration-300 ease-[var(--ease-out-expo)] group-hover:translate-x-1 motion-reduce:transform-none sm:text-2xl">{r.n}</h3>
              <p className="order-3 col-span-2 text-[15px] text-navy/55 sm:order-none sm:col-span-1">{r.in}</p>
              <p className="text-right">
                <CountUp value={r.p} prefix="$" className="text-3xl font-medium tracking-tight text-coral-deep tabular-nums sm:text-4xl" />
                <span className="ml-2 font-mono text-xs text-navy/45">{r.u}</span>
              </p>
            </StaggerItem>
          ))}
        </Stagger>
        <Reveal delay={0.1} className="mt-10">
          <Button href="/start" variant="navy">Get an eval <NudgeArrow /></Button>
        </Reveal>
      </div>
    </section>
  );
}

export function SampleFinding() {
  return (
    <section id="sample" aria-labelledby="sample-h" className="scroll-mt-6 border-t border-navy/10 px-5 py-28 sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[1fr_1.15fr] lg:items-center">
        <div>
          <SectionHead eyebrow="Sample report" title="Every finding comes with receipts.">
            <span id="sample-h" className="sr-only">Sample finding</span>
            Evidence excerpts, a verdict from an investigator agent, and a one-click way to reproduce it.
          </SectionHead>
          <Reveal delay={0.1}><Button href="/start" variant="navy">Get yours <NudgeArrow /></Button></Reveal>
        </div>
        <Reveal as="article" y={28} className="overflow-hidden rounded-3xl bg-navy text-cream">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-cream/10 px-6 py-4">
            <div className="flex items-center gap-2 text-sm text-cream/65"><WaveGlyph size={18} /> Finding F-2 · Trace Audit · support-bot v3</div>
            <StatusChip status="confirmed" />
          </header>
          <div className="space-y-5 px-6 py-6">
            <h3 className="text-2xl font-medium tracking-tight">Agent claims a refund was issued without calling the refund tool</h3>
            <p className="text-[15px] leading-relaxed text-cream/70">In turn 7 the assistant tells the customer the refund is complete, but no <code className="font-mono text-cream">issue_refund</code> call appears anywhere in the trace.</p>
            <figure>
              <figcaption className="mb-2 font-mono text-[11px] uppercase tracking-wider text-cream/45">Evidence · trace.json, turn 7</figcaption>
              <pre className="overflow-x-auto rounded-xl bg-navy-deep p-4 font-mono text-[13px] leading-relaxed text-cream/90"><code>{`{ "role": "assistant",
  "content": "Done — your refund of $42.00
              has been issued.",
  "tool_calls": [] }`}</code></pre>
            </figure>
            <div className="flex flex-wrap items-center gap-3 text-sm text-cream/55">
              <span className="inline-flex items-center gap-1.5 text-ok"><CircleCheck size={16} aria-hidden /> Reproduced 3 / 3</span>
              <span aria-hidden>·</span>
              <span className="font-mono">re-run: finding F-2</span>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="bg-navy-deep px-5 py-12 text-cream sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="inline-flex items-center gap-2 font-semibold tracking-tight text-cream"><WaveGlyph /> Autonomous Evals</p>
        <p className="max-w-md text-sm text-cream/50">Built and operated by AI agents. Pilot pricing; findings are evidence-backed and reproducible, not guarantees.</p>
        <nav aria-label="Footer" className="flex gap-5 text-sm text-cream/70">
          <a className="hover:text-cream focus-visible:outline-2 focus-visible:outline-offset-4" href="/start">Get an eval</a>
          <a className="hover:text-cream focus-visible:outline-2 focus-visible:outline-offset-4" href="#pricing">Pricing</a>
          <a className="hover:text-cream focus-visible:outline-2 focus-visible:outline-offset-4" href="#sample">Sample report</a>
        </nav>
      </div>
    </footer>
  );
}

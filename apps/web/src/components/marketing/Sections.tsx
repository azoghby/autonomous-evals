import { ArrowUpRight, CircleCheck, FileText, Send, Wallet, Bot } from "lucide-react";
import type { ReactNode } from "react";
import { Button, Chip, StatusChip, WaveGlyph } from "../ui";

function SectionHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-12 max-w-2xl">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-coral-deep">{eyebrow}</p>
      <h2 className="mt-3 text-balance text-4xl font-medium leading-[1.02] tracking-[-0.035em] text-navy sm:text-5xl">{title}</h2>
      {children && <p className="mt-4 text-lg text-navy/65">{children}</p>}
    </div>
  );
}

const STEPS = [
  { icon: Send, t: "Submit", d: "Paste a transcript, or point us at an endpoint. Pick a package or let us choose." },
  { icon: Bot, t: "Agent quote", d: "Our Commercial agent scopes the job and quotes from a fixed price table — in minutes." },
  { icon: Wallet, t: "Pay", d: "Checkout with Stripe. Work starts the moment payment clears; budgets are capped per job." },
  { icon: FileText, t: "Report", d: "An evidence-backed report with reproducible findings. Re-run any finding on demand." },
] as const;

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-h" className="scroll-mt-6 px-5 py-24 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <SectionHead eyebrow="How it works" title="Four steps. No humans in the loop to wait on.">
          <span id="how-h" className="sr-only">How it works</span>
          Every stage is run by an agent with a budget and an audit trail.
        </SectionHead>
        <ol className="grid gap-px overflow-hidden rounded-3xl border border-navy/10 bg-navy/10 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(({ icon: Icon, t, d }, i) => (
            <li key={t} className="flex flex-col gap-6 bg-cream p-7 transition-colors hover:bg-[#f9f4ea]">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm text-navy/40">0{i + 1}</span>
                <span className="grid size-10 place-items-center rounded-full bg-navy text-cream"><Icon size={18} aria-hidden /></span>
              </div>
              <div>
                <h3 className="text-2xl font-medium tracking-tight text-navy">{t}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-navy/65">{d}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const PRICES = [
  { n: "Trace Audit", in: "Paste or upload a transcript / tool logs (≤ 200 KB)", p: "$5", u: "per eval" },
  { n: "Text Eval", in: "OpenAI-compatible endpoint + system prompt", p: "$5", u: "per eval" },
  { n: "Workflow Eval", in: "Tool-calling endpoint, run in our calendar simulator", p: "$5", u: "per eval" },
  { n: "Version Comparison", in: "Two configs of a Text or Workflow Eval", p: "$10", u: "per comparison" },
  { n: "Monitoring", in: "Nightly re-run of your frozen suite, regression alerts", p: "$49", u: "per month" },
] as const;

export function Pricing() {
  return (
    <section id="pricing" aria-labelledby="pricing-h" className="scroll-mt-6 bg-[#ece3d1] px-5 py-24 sm:px-8">
      <div className="mx-auto max-w-6xl">
        <SectionHead eyebrow="Pricing" title="Priced like a coffee, not a contract.">
          <span id="pricing-h" className="sr-only">Pricing</span>
          Pilot pricing — fixed prices, quoted by our agents, no sales call.
        </SectionHead>
        <div id="services" className="scroll-mt-6 divide-y divide-navy/12 border-y border-navy/12">
          {PRICES.map((r) => (
            <div key={r.n} className="group grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-1 py-6 transition-colors sm:grid-cols-[14rem_1fr_auto]">
              <h3 className="text-xl font-medium tracking-tight text-navy sm:text-2xl">{r.n}</h3>
              <p className="order-3 col-span-2 text-[15px] text-navy/60 sm:order-none sm:col-span-1">{r.in}</p>
              <p className="text-right"><span className="text-3xl font-medium tracking-tight text-navy sm:text-4xl">{r.p}</span><span className="ml-2 font-mono text-xs text-navy/50">{r.u}</span></p>
            </div>
          ))}
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Button href="/start" className="!bg-navy !text-cream !shadow-none hover:!bg-navy-soft focus-visible:!outline-navy">Get an eval <ArrowUpRight size={16} aria-hidden /></Button>
          <Chip className="!border-navy/20 !bg-transparent !text-navy/70">Pilot pricing</Chip>
        </div>
      </div>
    </section>
  );
}

export function SampleFinding() {
  return (
    <section id="sample" aria-labelledby="sample-h" className="scroll-mt-6 px-5 py-24 sm:px-8">
      <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[1fr_1.15fr] lg:items-center">
        <div>
          <SectionHead eyebrow="Sample report" title="Every finding comes with receipts.">
            <span id="sample-h" className="sr-only">Sample finding</span>
            Evidence excerpts, a verdict from an investigator agent, and a one-click way to reproduce it.
          </SectionHead>
          <Button href="/start" variant="coral" className="!text-navy-deep">Get yours <ArrowUpRight size={16} aria-hidden /></Button>
        </div>
        <article className="overflow-hidden rounded-3xl bg-navy text-cream shadow-[0_30px_80px_-30px_rgb(20_33_61/0.6)]">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-cream/10 px-6 py-4">
            <div className="flex items-center gap-2 text-sm text-cream/70"><WaveGlyph size={18} /> Finding F-2 · Trace Audit · support-bot v3</div>
            <StatusChip status="confirmed" />
          </header>
          <div className="space-y-5 px-6 py-6">
            <h3 className="text-2xl font-medium tracking-tight">Agent claims a refund was issued without calling the refund tool</h3>
            <p className="text-[15px] leading-relaxed text-cream/70">In turn 7 the assistant tells the customer the refund is complete, but no <code className="font-mono text-cream">issue_refund</code> call appears anywhere in the trace.</p>
            <figure>
              <figcaption className="mb-2 font-mono text-[11px] uppercase tracking-wider text-cream/50">Evidence · trace.json, turn 7</figcaption>
              <pre className="overflow-x-auto rounded-xl border border-cream/10 bg-navy-deep p-4 font-mono text-[13px] leading-relaxed text-cream/90"><code>{`{ "role": "assistant",
  "content": "Done — your refund of $42.00
              has been issued.",
  "tool_calls": [] }`}</code></pre>
            </figure>
            <div className="flex flex-wrap items-center gap-3 text-sm text-cream/60">
              <span className="inline-flex items-center gap-1.5 text-ok"><CircleCheck size={16} aria-hidden /> Reproduced 3 / 3</span>
              <span aria-hidden>·</span>
              <span className="font-mono">re-run: finding F-2</span>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="bg-navy-deep text-cream px-5 py-12 sm:px-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="inline-flex items-center gap-2 font-semibold tracking-tight"><WaveGlyph /> Autonomous Evals</p>
        <p className="max-w-md text-sm text-cream/55">Built and operated by AI agents. Pilot pricing; findings are evidence-backed and reproducible, not guarantees.</p>
        <nav aria-label="Footer" className="flex gap-5 text-sm text-cream/75">
          <a className="hover:text-cream focus-visible:outline-2 focus-visible:outline-offset-4" href="/start">Get an eval</a>
          <a className="hover:text-cream focus-visible:outline-2 focus-visible:outline-offset-4" href="#pricing">Pricing</a>
          <a className="hover:text-cream focus-visible:outline-2 focus-visible:outline-offset-4" href="#sample">Sample report</a>
        </nav>
      </div>
    </footer>
  );
}

import { ArrowUpRight, FileSearch, RotateCcw, Timer, Wallet, Bot } from "lucide-react";
import { Button, RibbedGlow, TopBar, GlassCard, Chip } from "../ui";

const FEATURES = [
  { icon: Bot, a: "Agent-run,", b: "end to end" },
  { icon: Timer, a: "Quote", b: "in minutes" },
  { icon: Wallet, a: "Pay per eval", b: "from $5" },
  { icon: FileSearch, a: "Reproducible", b: "findings" },
  { icon: RotateCcw, a: "Re-run any", b: "finding" },
] as const;

function JobCard({ title, sub, dates, findings, chip, offset }: { title: string; sub: string; dates: string; findings: string; chip: string; offset?: boolean }) {
  return (
    <GlassCard className={`reveal w-full max-w-[22rem] p-5 ${offset ? "lg:ml-14" : ""}`} style={{ animationDelay: offset ? "0.35s" : "0.2s" }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[15px] font-medium text-cream">{title}</p>
          <p className="font-mono text-xs text-cream/55">{sub}</p>
        </div>
        <Chip tone="ok" dot>{chip}</Chip>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-cream/50">Timeline</p>
          <p className="mt-1 text-sm text-cream">{dates}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wider text-cream/50">Findings</p>
          <p className="mt-1 text-3xl font-medium leading-none tracking-tight text-cream">{findings}</p>
        </div>
      </div>
    </GlassCard>
  );
}

export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="p-2 sm:p-3">
      <div className="relative isolate flex min-h-[44rem] flex-col overflow-hidden rounded-[2rem] bg-navy sm:min-h-[48rem] lg:min-h-[calc(100svh-1.5rem)] lg:rounded-[2.5rem]">
        <RibbedGlow />
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-navy-deep/70 to-transparent" aria-hidden />
        <TopBar active="/#services" />

        <div className="relative z-10 flex flex-1 flex-col justify-between gap-10 px-5 pb-6 pt-6 sm:px-8 lg:pt-2">
          <div className="flex flex-col items-start gap-4 lg:items-end">
            <Chip tone="coral" className="reveal bg-coral/90 !text-navy-deep border-transparent px-3.5 py-1.5 text-[13px]">First audit $5</Chip>
            <JobCard title="Trace Audit" sub="support-bot v3" dates="Submitted Fri 14 → Delivered Fri 14" findings="4" chip="4.2 / 5" />
            <JobCard title="Workflow Eval" sub="calendar agent" dates="Submitted Sat 15 → Running" findings="7" chip="2 confirmed" offset />
          </div>

          <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-4xl">
              <h1 id="hero-heading" className="reveal text-balance text-[clamp(3.1rem,1.2rem+9vw,7.5rem)] font-medium leading-[0.92] tracking-[-0.045em] text-cream">
                Agents build<br className="hidden sm:block" /> your evals.
              </h1>
              <p className="reveal mt-6 max-w-xl text-base leading-relaxed text-cream/70 sm:text-lg" style={{ animationDelay: "0.15s" }}>
                Hand us your agent. Our agents scope it, quote it, test it, and hand back reproducible findings — no setup, no platform to learn.
              </p>
            </div>
            <div className="reveal flex items-center gap-5 sm:gap-6" style={{ animationDelay: "0.3s" }}>
              <Button href="/start" size="lg">Get an eval <ArrowUpRight size={18} aria-hidden /></Button>
              <a href="#sample" className="inline-flex items-center gap-1 text-[15px] text-cream/80 underline-offset-4 hover:text-cream hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cream">
                See a sample report <ArrowUpRight size={16} aria-hidden />
              </a>
            </div>
          </div>

          <div>
            <div className="relative h-px w-full bg-cream/15" aria-hidden>
              <span className="absolute left-0 top-1/2 h-[3px] w-24 -translate-y-1/2 rounded-full bg-coral" />
            </div>
            <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
              {FEATURES.map(({ icon: Icon, a, b }, i) => (
                <li key={a} className={`flex items-center gap-3 ${i === 4 ? "col-span-2 sm:col-span-1" : ""}`}>
                  <Icon size={20} aria-hidden className={i === 0 ? "text-coral" : "text-cream/55"} />
                  <span className={`text-[13px] leading-tight ${i === 0 ? "text-coral" : "text-cream/55"}`}>
                    {a}<br />{b}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}


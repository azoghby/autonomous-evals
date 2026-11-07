"use client";
import { createTimeline, stagger } from "animejs";
import { useEffect, useRef } from "react";
import { Button, GlassCard, NudgeArrow, RibbedGlow, StatusChip, TopBar } from "../ui";

const FEATURES = [
  ["Agent-run", "end to end"],
  ["Quote", "in minutes"],
  ["Pay per eval", "from $5"],
  ["Reproducible", "findings"],
  ["Re-run any", "finding"],
] as const;

const JOBS = [
  { title: "Trace Audit", sub: "support-bot v3", status: "delivered", n: "4" },
  { title: "Workflow Eval", sub: "calendar agent", status: "running", n: "7" },
] as const;

const HEADLINE = [["Agents", "build"], ["your", "evals."]] as const;

function Word({ children }: { children: string }) {
  return (
    <span className="inline-block overflow-hidden pb-[0.12em] align-bottom">
      <span data-word className="pre pre-rise inline-block">{children}</span>
    </span>
  );
}

export function Hero() {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("hero-ready");
      return;
    }
    const q = (s: string) => el.querySelectorAll<HTMLElement>(s);
    const tl = createTimeline({ defaults: { ease: "outExpo", duration: 1000 } })
      .add(q("[data-word]"), { translateY: ["105%", "0%"], opacity: [0, 1], duration: 1100 }, stagger(90))
      .add(q("[data-sub]"), { translateY: [16, 0], opacity: [0, 1] }, 420)
      .add(q("[data-cta]"), { translateY: [14, 0], opacity: [0, 1], duration: 800 }, 620)
      .add(q("[data-card]"), { translateY: [18, 0], opacity: [0, 1] }, 760)
      .add(q("[data-rule]"), { scaleX: [0, 1], opacity: [0, 1], duration: 1400 }, 700)
      .add(q("[data-feat]"), { translateY: [10, 0], opacity: [0, 1], duration: 800 }, stagger(70, { start: 900 }));
    return () => { tl.revert(); };
  }, []);

  return (
    <section aria-labelledby="hero-heading" className="p-2 sm:p-3">
      <div ref={root} className="relative isolate flex min-h-[44rem] flex-col overflow-hidden rounded-[2rem] bg-navy sm:min-h-[48rem] lg:min-h-[calc(100svh-1.5rem)] lg:rounded-[2.5rem]">
        <RibbedGlow />
        <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-navy-deep/70 to-transparent" aria-hidden />
        <TopBar active="/#services" />

        <div className="relative z-10 flex flex-1 flex-col justify-between gap-10 px-5 pb-6 pt-6 sm:px-8 lg:pt-2">
          <GlassCard data-card className="pre order-2 w-full max-w-[20rem] self-start px-5 py-1 lg:order-1 lg:self-end">
            <p className="pt-4 text-[11px] uppercase tracking-[0.14em] text-cream/45">Recent evals</p>
            <ul className="divide-y divide-cream/10">
              {JOBS.map((j) => (
                <li key={j.title} className="flex items-center justify-between gap-6 py-4">
                  <div>
                    <p className="text-[15px] font-medium text-cream">{j.title}</p>
                    <p className="mt-0.5 font-mono text-xs text-cream/45">{j.sub}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-2xl font-medium leading-none tracking-tight text-cream">{j.n}</p>
                    <StatusChip status={j.status} className="mt-2" />
                  </div>
                </li>
              ))}
            </ul>
          </GlassCard>

          <div className="order-1 flex flex-col gap-8 lg:order-2 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-4xl">
              <h1 id="hero-heading" className="text-[clamp(3.1rem,1.2rem+9vw,7.5rem)] font-medium leading-[0.92] tracking-[-0.045em] text-cream">
                <span className="sr-only">Agents build your evals.</span>
                <span aria-hidden>
                  {HEADLINE.map((line, i) => (
                    <span key={i} className={i === 0 ? "block" : "block"}>
                      {line.map((w, j) => (<span key={w}><Word>{w}</Word>{j < line.length - 1 ? " " : ""}</span>))}
                    </span>
                  ))}
                </span>
              </h1>
              <p data-sub className="pre mt-6 max-w-xl text-base leading-relaxed text-cream/70 sm:text-lg">
                Hand us your agent. Our agents scope it, quote it, test it, and hand back reproducible findings — no setup, no platform to learn.
              </p>
            </div>
            <div data-cta className="pre flex flex-col items-start gap-3">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <Button href="/start" size="lg">Get an eval <NudgeArrow size={18} /></Button>
                <Button href="#sample" variant="quiet" className="group">See a sample report <NudgeArrow /></Button>
              </div>
              <p className="font-mono text-xs text-cream/50">First audit $5</p>
            </div>
          </div>

          <div className="order-3">
            <span data-rule className="pre block h-px w-full origin-left bg-cream/20" aria-hidden />
            <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
              {FEATURES.map(([a, b], i) => (
                <li key={a} data-feat className={`pre text-[13px] leading-tight text-cream/55 ${i === 4 ? "col-span-2 sm:col-span-1" : ""}`}>
                  <span className="text-cream/85">{a}</span><br />{b}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

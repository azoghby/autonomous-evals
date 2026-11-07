"use client";
import { createTimeline, stagger } from "animejs";
import { useEffect, useRef } from "react";
import { Button, NudgeArrow, RibField, TopBar } from "../ui";

const FEATURES = [
  ["Agent-run", "end to end"],
  ["Quote", "in minutes"],
  ["Pay per eval", "from $5"],
  ["Reproducible", "findings"],
  ["Re-run any", "finding"],
] as const;

const HEADLINE = [["Agents", "build"], ["your", "evals."]] as const;

function Word({ children, accent }: { children: string; accent?: boolean }) {
  return (
    <span className="relative inline-block overflow-hidden pb-[0.12em] align-bottom">
      <span data-word className="pre pre-rise relative inline-block">
        {children}
        {accent && <span aria-hidden className="bolt-underline absolute -bottom-px left-0 h-[3px] w-full" />}
      </span>
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
      .add(q("[data-rule]"), { scaleX: [0, 1], opacity: [0, 1], duration: 1400 }, 700)
      .add(q("[data-feat]"), { translateY: [10, 0], opacity: [0, 1], duration: 800 }, stagger(70, { start: 900 }));
    return () => { tl.revert(); };
  }, []);

  return (
    <section aria-labelledby="hero-heading" className="relative isolate overflow-hidden bg-bg">
      <RibField />
      <div ref={root} className="relative z-10 flex min-h-screen min-h-svh flex-col">
        <TopBar active="/#services" />
        <div className="flex flex-1 flex-col justify-end px-5 pb-8 pt-24 sm:px-8">
          <div className="mx-auto flex w-full max-w-[88rem] flex-col gap-12">
            <h1 id="hero-heading" className="text-[clamp(3.5rem,9vw,9rem)] font-medium leading-[0.95] tracking-[-0.04em] text-white">
              <span className="sr-only">Agents build your evals.</span>
              <span aria-hidden>
                {HEADLINE.map((line, i) => (
                  <span key={i} className="block">
                    {line.map((w, j) => (
                      <span key={w}>
                        <Word accent={i === 1 && j === 1}>{w}</Word>
                        {j < line.length - 1 ? " " : ""}
                      </span>
                    ))}
                  </span>
                ))}
              </span>
            </h1>
            <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
              <p data-sub className="pre max-w-[35rem] text-[17px] leading-[1.55] text-muted sm:text-[19px]">
                Hand us your agent. Our agents scope it, quote it, test it, and hand back reproducible findings — no setup, no platform to learn.
              </p>
              <div data-cta className="pre flex flex-wrap items-center gap-x-8 gap-y-4">
                <Button href="/start" size="lg">Get an eval <NudgeArrow size={18} /></Button>
                <Button href="/sample" variant="quiet" className="group">See a sample report <NudgeArrow /></Button>
              </div>
            </div>
            <div>
              <span data-rule className="pre block h-px w-full origin-left bg-line-strong" aria-hidden />
              <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-5">
                {FEATURES.map(([a, b], i) => (
                  <li key={a} data-feat className={`pre font-mono text-xs leading-snug ${i === 0 ? "text-accent-bright" : "text-subtle"} ${i === 4 ? "col-span-2 sm:col-span-1" : ""}`}>
                    <span className={i === 0 ? "" : "text-muted"}>{a}</span><br />{b}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

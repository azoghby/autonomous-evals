import type { CSSProperties } from "react";
import { PRICE_CENTS } from "@ae/core/contracts/index";
import { Button, Eyebrow, NudgeArrow, RibField, TopBar } from "../ui";

const MIN_PRICE = Math.min(...Object.values(PRICE_CENTS)) / 100;

const HEADLINE = [["Agents", "build"], ["your", "evals."]] as const;

function Word({ children, accent, i }: { children: string; accent?: boolean; i: number }) {
  return (
    <span className="relative inline-block overflow-hidden pb-[0.12em] align-bottom">
      <span className="pre pre-rise relative inline-block" style={enter(i * 90, 1100)}>
        {children}
        {accent && <span aria-hidden className="bolt-underline absolute -bottom-px left-0 h-[3px] w-full" />}
      </span>
    </span>
  );
}

/** Entrance timing (ms) consumed by the CSS `.pre` keyframes; no JS needed, so first paint is never gated on hydration. */
const enter = (delay: number, dur = 1000): CSSProperties => ({ "--delay": `${delay}ms`, "--dur": `${dur}ms` }) as CSSProperties;

const FEATURES = [
  ["Agent-run", "End to end"],
  ["Quote", "In minutes"],
  ["Pay", `From $${MIN_PRICE}`],
  ["Reproducible", "Re-run any finding"],
] as const;

/** Hairline cell borders: 2x2 below lg, single row at lg. */
const CELL = [
  "",
  "border-l pl-4",
  "border-t lg:border-t-0 lg:border-l lg:pl-4",
  "border-t border-l pl-4 lg:border-t-0",
] as const;

export function Hero() {
  return (
    <section id="services" aria-labelledby="hero-heading" className="relative isolate overflow-hidden bg-bg">
      <RibField />
      <div className="relative z-10 flex min-h-screen min-h-svh flex-col">
        <TopBar active="/#services" />
        <div className="container-x flex flex-1 flex-col justify-end pb-8 pt-24">
          <div className="flex w-full flex-col gap-10 md:gap-12">
            <div className="flex flex-col gap-6">
              <div style={enter(0, 800)} className="pre pre-lift pre-lift-xs">
                <Eyebrow>Evals as a service · run by agents</Eyebrow>
              </div>
              <h1 id="hero-heading" className="t-display text-white">
                <span className="sr-only">Agents build your evals.</span>
                <span aria-hidden>
                  {HEADLINE.map((line, i) => (
                    <span key={i} className="block">
                      {line.map((w, j) => (
                        <span key={w}>
                          <Word i={i * 2 + j} accent={i === 1 && j === 1}>{w}</Word>
                          {j < line.length - 1 ? " " : ""}
                        </span>
                      ))}
                    </span>
                  ))}
                </span>
              </h1>
            </div>
            <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
              <p style={enter(420)} className="pre pre-lift t-lead max-w-[35rem]">
                Hand us your agent. Our agents scope it, quote it, test it, and hand back reproducible findings, with no setup and no platform to learn.
              </p>
              <div style={enter(620, 800)} className="pre pre-lift pre-lift-sm flex flex-wrap items-center gap-x-8 gap-y-4">
                <Button href="/start" size="lg">Get an eval <NudgeArrow size={18} /></Button>
                <Button href="/sample" variant="quiet" className="group">See a sample report <NudgeArrow /></Button>
              </div>
            </div>
            <ul className="grid grid-cols-2 border-t border-line-2 lg:grid-cols-4">
              {FEATURES.map(([a, b], i) => (
                <li
                  key={a}
                  style={enter(900 + i * 70, 800)}
                  className={`pre pre-lift pre-lift-xs flex flex-col gap-1.5 border-line-2 py-4 pr-4 font-mono text-xs ${CELL[i]}`}
                >
                  <span className="uppercase text-fg-2">{a}</span>
                  <span className="text-subtle">{b}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

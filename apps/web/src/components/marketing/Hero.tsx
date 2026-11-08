import type { CSSProperties } from "react";
import { Button, Eyebrow, NudgeArrow, RibField, TopBar } from "../ui";

/** Entrance timing (ms) consumed by the CSS `.pre` keyframes; no JS needed, so first paint is never gated on hydration. */
const enter = (delay: number, dur = 1000): CSSProperties => ({ "--delay": `${delay}ms`, "--dur": `${dur}ms` }) as CSSProperties;

export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-heading" className="relative isolate overflow-hidden bg-bg">
      <RibField />
      <div className="relative z-10 flex min-h-screen min-h-svh flex-col">
        <TopBar />
        <div className="container-x flex flex-1 flex-col justify-center pb-20 pt-24">
          <div className="flex max-w-[48rem] flex-col gap-8">
            <div style={enter(0, 800)} className="pre pre-lift pre-lift-xs">
              <Eyebrow>Sandbox evals for AI agents</Eyebrow>
            </div>
            <h1 id="hero-heading" style={enter(120, 1100)} className="pre pre-lift t-display text-white text-balance">
              See what your agent really does.
            </h1>
            <p style={enter(380)} className="pre pre-lift t-lead max-w-[34rem]">
              We rebuild your agent&apos;s world in a sandbox, run simulated users through it, and grade the database, not the chat.
            </p>
            <div style={enter(580, 800)} className="pre pre-lift pre-lift-sm flex flex-wrap items-center gap-x-8 gap-y-4">
              <Button href="/demo" size="lg">Watch a real run <NudgeArrow size={18} /></Button>
              <Button href="/start" variant="quiet" className="group">Start an eval <NudgeArrow /></Button>
            </div>
            <p style={enter(800, 800)} className="pre pre-lift pre-lift-xs font-mono text-xs uppercase text-subtle">
              Every run in its own Neon database branch
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

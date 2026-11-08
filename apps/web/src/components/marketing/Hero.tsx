import type { CSSProperties } from "react";
import { Button, Eyebrow, NudgeArrow, RibField, TopBar } from "../ui";

/** Entrance timing (ms) consumed by the CSS `.pre` keyframes; no JS needed, so first paint is never gated on hydration. */
const enter = (delay: number, dur = 1000): CSSProperties => ({ "--delay": `${delay}ms`, "--dur": `${dur}ms` }) as CSSProperties;

const PROOF = [
  { label: "Own Neon branch per run", c: "var(--cyan)" },
  { label: "Graded on database state", c: "var(--ok)" },
  { label: "Red-team built in", c: "var(--violet)" },
] as const;

export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-heading" className="relative isolate overflow-hidden bg-bg">
      <RibField />
      <div aria-hidden className="hero-aurora" />
      <div aria-hidden className="hero-beam" />
      <div className="relative z-10 flex min-h-screen min-h-svh flex-col">
        <TopBar />
        <div className="container-x flex flex-1 flex-col justify-center pb-20 pt-24">
          <div className="flex max-w-[52rem] flex-col gap-8">
            <div style={enter(0, 800)} className="pre pre-lift pre-lift-xs">
              <Eyebrow>Sandbox evals for AI agents</Eyebrow>
            </div>
            <h1 id="hero-heading" style={enter(120, 1100)} className="pre pre-lcp pre-lift t-display text-white text-balance">
              Staging for <span className="grad-text">AI agents</span>.
            </h1>
            <p style={enter(380)} className="pre pre-lift t-lead max-w-[34rem]">
              A copy of your world, thousands of simulated users, graded on what actually changed. Built for long, tool-heavy, multi-turn agents.
            </p>
            <div style={enter(580, 800)} className="pre pre-lift pre-lift-sm flex flex-wrap items-center gap-x-8 gap-y-4">
              <span className="btn-spectrum"><Button href="/demo" size="lg">Watch a real run <NudgeArrow size={18} /></Button></span>
              <Button href="/start" variant="quiet" className="group">Start an eval <NudgeArrow /></Button>
            </div>
            <ul style={enter(800, 800)} className="pre pre-lift pre-lift-xs flex flex-wrap gap-x-6 gap-y-3">
              {PROOF.map((p) => (
                <li key={p.label} className="hero-chip" style={{ "--c": p.c } as CSSProperties}><i aria-hidden />{p.label}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

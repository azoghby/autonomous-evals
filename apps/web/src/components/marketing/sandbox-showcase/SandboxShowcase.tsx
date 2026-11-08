import type { CSSProperties } from "react";
import { Button, Eyebrow, NudgeArrow, Reveal, Section } from "@/components/ui";
import { SandboxDiagram } from "./SandboxDiagram";

const GATES = [
  { k: "Oracle agent", v: "must pass", c: "var(--ok)" },
  { k: "Do-nothing, empty and dump agents", v: "must fail", c: "var(--danger)" },
  { k: "Grader mutation test", v: "must catch it", c: "var(--warn)" },
] as const;

/** Landing "how it works, in depth": the animated sample-run diagram plus the grader quality gates. */
export function SandboxShowcase() {
  return (
    <Section id="sandbox" labelledBy="sandbox-h" band atmosphere="glow" className="ss-home scroll-mt-16">
      <Reveal className="flex flex-col gap-6">
        <Eyebrow>Inside a run</Eyebrow>
        <h2 id="sandbox-h" className="t-h2 max-w-[26ch] text-balance text-fg">Your agent, in a copy of its own world. <span className="text-muted">Real tools, real state, graded on what changed.</span></h2>
      </Reveal>
      <Reveal className="mt-12 md:mt-16">
        <SandboxDiagram />
      </Reveal>
      <div className="mt-10 grid gap-4 md:grid-cols-3">
        {GATES.map((g) => (
          <div key={g.k} className="ss-gate" style={{ "--c": g.c } as CSSProperties}>
            <p className="text-[14px] text-fg-2">{g.k}</p>
            <p className="mt-1.5 font-mono text-[11px] uppercase" style={{ color: g.c }}>{g.v}</p>
          </div>
        ))}
      </div>
      <div className="mt-10 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="t-small max-w-[44ch] text-muted">We check the grader before we trust it with your agent.</p>
        <div className="flex flex-wrap gap-3">
          <Button href="/sandbox" variant="outline" className="group">Explore Sandbox evals <NudgeArrow /></Button>
          <Button href="/sandbox/runs/sample" variant="quiet" className="group">See a sample report <NudgeArrow /></Button>
        </div>
      </div>
    </Section>
  );
}

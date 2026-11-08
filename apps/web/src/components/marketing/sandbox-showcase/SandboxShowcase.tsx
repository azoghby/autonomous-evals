import { Button, Reveal, Section, SectionHeader } from "@/components/ui";
import { SandboxDiagram } from "./SandboxDiagram";

const GATES = [
  { k: "Oracle", v: "must pass" },
  { k: "Do-nothing, empty and dump agents", v: "must fail" },
  { k: "Grader mutation test", v: "must catch it" },
] as const;

const MODES = [
  { n: "A", title: "Endpoint", sub: "tool loop" },
  { n: "B", title: "Your tools", sub: "via our sandbox API / MCP" },
  { n: "C", title: "Your repo", sub: "in a Vercel Sandbox microVM" },
  { n: "D", title: "Realtime voice", sub: "spoken scenarios" },
  { n: "E", title: "Staging", sub: "your own environment" },
] as const;

export function SandboxShowcase() {
  return (
    <Section id="sandbox" labelledBy="sandbox-h" className="scroll-mt-16 [content-visibility:auto] [contain-intrinsic-size:auto_1700px]">
      <Reveal>
        <SectionHeader
          id="sandbox-h"
          index="02"
          eyebrow="Sandbox evals"
          title={<>Your agent, in a copy of its own world. <span className="text-muted">Real tools, real state, graded on what changed.</span></>}
        />
      </Reveal>
      <Reveal className="mt-14 md:mt-20">
        <SandboxDiagram />
      </Reveal>

      <div className="mt-10 grid gap-10 lg:grid-cols-12 lg:gap-8">
        <div className="lg:col-span-5">
          <h3 className="t-eyebrow text-fg-2">Quality gates</h3>
          <p className="t-small mt-2 max-w-[44ch] text-muted">We check the grader before we trust it with your agent.</p>
          <ul className="mt-4 border-t border-line-2">
            {GATES.map((g) => (
              <li key={g.k} className="flex items-baseline justify-between gap-4 border-b border-line-2 py-3">
                <span className="min-w-0 text-[14px] text-fg-2">{g.k}</span>
                <span className="shrink-0 font-mono text-[11px] uppercase text-accent-text">{g.v}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="lg:col-span-7">
          <h3 className="t-eyebrow text-fg-2">Connect modes</h3>
          <p className="t-small mt-2 max-w-[44ch] text-muted">Five ways to plug in, whoever runs the loop.</p>
          <ul className="mt-4 grid border-t border-l border-line-2 sm:grid-cols-2 lg:grid-cols-3">
            {MODES.map((m) => (
              <li key={m.n} className="ss-mode min-w-0 border-b border-r border-line-2 p-4">
                <span className="font-mono text-[11px] text-subtle">{m.n}</span>
                <p className="mt-2 text-[15px] text-fg">{m.title}</p>
                <p className="t-small mt-0.5 break-words text-muted">{m.sub}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row">
        <Button href="/sandbox" variant="primary" size="lg">Explore Sandbox evals</Button>
        <Button href="/sandbox/runs/sample" variant="outline" size="lg">See a sample report</Button>
      </div>
    </Section>
  );
}

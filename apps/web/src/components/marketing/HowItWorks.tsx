import Link from "next/link";
import { Eyebrow, Reveal, Section } from "../ui";

const STEPS = [
  { n: "01", title: "Connect your agent", body: "An endpoint, an MCP server, or your repo. Dozens of tools are fine." },
  { n: "02", title: "We build its world", body: "Your tools, policies and data in a real Postgres database, modelled on yours." },
  { n: "03", title: "Simulated users run it", body: "Long, multi-turn workflows at scale, each run in its own Neon database branch." },
  { n: "04", title: "Graded on what changed", body: "We diff the database, not the transcript. pass^k with confidence intervals." },
] as const;

export function HowItWorks() {
  return (
    <Section id="how" labelledBy="how-h" className="scroll-mt-16">
      <Reveal className="flex flex-col gap-6">
        <Eyebrow>How it works</Eyebrow>
        <h2 id="how-h" className="t-h2 max-w-[22ch] text-balance text-fg">Four steps. <span className="text-muted">No platform to learn.</span></h2>
      </Reveal>
      <Reveal className="mt-16 md:mt-24">
        <ol className="ls-steps">
          {STEPS.map((s) => (
            <li key={s.n} className="ls-step">
              <span aria-hidden className="ls-dot" />
              <span className="ls-num">{s.n}</span>
              <h3 className="t-h4 text-fg">{s.title}</h3>
              <p className="t-small text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-12 text-[14px]">
          <Link href="/company" className="text-fg-2 underline decoration-line-3 underline-offset-4 transition-colors hover:text-accent-text focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">See the agents that run this company →</Link>
        </p>
      </Reveal>
    </Section>
  );
}

import { Eyebrow, Reveal, Section } from "../ui";

const STEPS = [
  { n: "01", title: "Connect your agent", body: "An endpoint, an MCP server, or your repo." },
  { n: "02", title: "We build its world", body: "Tools, policies and a real Postgres database, modelled on yours." },
  { n: "03", title: "Simulated users run it", body: "Your real workflows, each in an isolated Neon database branch." },
  { n: "04", title: "Graded on what changed", body: "We check the database, not what the agent said." },
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
              <span className="font-mono text-xs text-accent-text">{s.n}</span>
              <h3 className="t-h4 text-fg">{s.title}</h3>
              <p className="t-small text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </Reveal>
    </Section>
  );
}

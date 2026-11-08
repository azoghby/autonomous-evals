import Link from "next/link";
import { Button, Container, NudgeArrow, Wordmark } from "../ui";

const COLS = [
  ["Product", [["Get an eval", "/start"], ["Sandbox evals", "/sandbox"], ["Sample report", "/sample"], ["Sandbox sample", "/sandbox/runs/sample"], ["Pricing", "/#pricing"]]],
  ["Agents", [["MCP", "/#mcp"], ["API keys", "/settings/keys"]]],
  ["Network", [["Experts", "/experts"], ["Leaderboard", "/leaderboard"], ["Submit your agent", "/leaderboard/submit"]]],
  ["Account", [["Dashboard", "/jobs"]]],
] as const;

export function ClosingCta() {
  return (
    <section aria-labelledby="cta-h" className="relative overflow-hidden border-t border-line-2 bg-bg-band py-24 md:py-40">
      <div className="blue-light" aria-hidden="true" />
      <div className="grid-lines" aria-hidden="true" />
      <Container className="relative flex flex-col gap-12 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 id="cta-h" className="text-balance text-[clamp(44px,7vw,104px)] leading-[0.98] tracking-[-0.045em] text-fg">
            Hand us your agent.<br /><span className="text-muted">Get findings back.</span>
          </h2>
          <div className="cta-line" aria-hidden="true"><span className="cta-sweep" /></div>
        </div>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <span className="cta-cta">
            <Button href="/start" size="lg" className="bolt-sweep relative">Get an eval <NudgeArrow size={18} /></Button>
          </span>
          <Button href="/sample" variant="quiet" className="group">See a sample report <NudgeArrow /></Button>
        </div>
      </Container>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line-2 bg-bg py-12 md:py-16">
      <Container className="flex flex-col gap-12">
        <div className="grid gap-10 lg:grid-cols-12">
          <div className="lg:col-span-4"><Wordmark /></div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-4 lg:col-span-8">
            {COLS.map(([h, links]) => (
              <div key={h} className="flex flex-col gap-4">
                <span className="font-mono text-[11px] uppercase text-subtle">{h}</span>
                <ul className="flex flex-col gap-3">
                  {links.map(([l, href]) => (
                    <li key={l}><Link href={href} className="text-[14px] text-fg-2 transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">{l}</Link></li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>
        <p className="border-t border-line-2 pt-6 font-mono text-[11px] uppercase text-subtle">Pilot pricing. Findings are evidence-backed and reproducible, not guarantees.</p>
      </Container>
    </footer>
  );
}

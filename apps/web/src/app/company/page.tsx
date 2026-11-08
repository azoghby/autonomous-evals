import type { Metadata } from "next";
import { HUMAN_GATES } from "@ae/core/company/registry";
import { Button, Container, Eyebrow, NudgeArrow, Section, TopBar } from "@/components/ui";
import { Footer } from "@/components/marketing/Footer";
import { AgentCard } from "@/components/company/AgentCard";
import { DEPARTMENT_LABEL, DEPARTMENT_ORDER, relativeTime } from "@/components/company/format";
import { getPublicOrgChart, type PublicAgentNode } from "@/server/company/queries";

export const revalidate = 60;

export const metadata: Metadata = {
  title: "Company · Standard Evals",
  description: "Standard Evals is run by AI agents with a human founder approving anything that reaches the outside world. See the org chart, what each agent did this week, and the approval gates.",
};

const NAV = [
  { label: "Demo", href: "/demo" },
  { label: "Sandbox", href: "/sandbox" },
  { label: "Leaderboard", href: "/leaderboard" },
  { label: "MCP", href: "/#mcp" },
  { label: "Pricing", href: "/pricing" },
];

const DEPT_BLURB: Record<string, string> = {
  leadership: "Sets the day's plan. Can only assign work to other agents.",
  growth: "Finds the market and the people who need us. Cannot contact anyone on its own.",
  customer: "Talks to people who asked to be talked to.",
  evaluation: "Does the actual product work: tests, simulated users, grading.",
  operations: "Keeps reports and follow-ups flowing.",
};

export default async function CompanyPage() {
  const now = new Date();
  const chart = await getPublicOrgChart(now);
  const byId = new Map(chart.agents.map((a) => [a.id, a]));
  const groups = DEPARTMENT_ORDER.map((d) => ({ dept: d, nodes: chart.agents.filter((a) => a.department === d) })).filter((g) => g.nodes.length > 0);
  const gated = chart.agents.filter((a) => a.gates.length > 0 && a.contactsExternally);

  return (
    <div className="bg-bg text-fg">
      <TopBar nav={NAV} active="/company" />
      <main id="main" tabIndex={-1} className="outline-none">
        <Section atmosphere="glow" labelledBy="company-h" className="!pb-12 md:!pb-16 !pt-16 md:!pt-24">
          <div className="flex flex-col gap-6">
            <Eyebrow>Company</Eyebrow>
            <h1 id="company-h" className="t-h1 max-w-[20ch] text-balance">This company is <span className="text-muted">run by agents.</span></h1>
            <p className="t-lead max-w-[60ch]">
              Standard Evals evaluates other companies&apos; AI agents, so we hold ourselves to the same standard: our own work is done by agents too.
              A planner assigns the day, researchers and prospectors find the market, and evaluators run the product.
              A human founder approves anything that reaches the outside world.
            </p>
            <p className="font-mono text-[11px] uppercase text-subtle">
              {chart.activityAvailable ? `Live from our database · updated ${relativeTime(chart.generatedAt, now) || "just now"}` : "Activity unavailable right now. Showing the org chart only."}
            </p>
          </div>
        </Section>

        <Section band labelledBy="org-h">
          <div className="flex flex-col gap-4">
            <Eyebrow>Org chart</Eyebrow>
            <h2 id="org-h" className="t-h2 max-w-[24ch] text-balance">{chart.agents.length} agents, <span className="text-muted">five departments.</span></h2>
          </div>
          <div className="mt-12 flex flex-col gap-14 md:mt-16">
            {groups.map(({ dept, nodes }) => (
              <section key={dept} aria-labelledby={`dept-${dept}`} className="grid gap-6 lg:grid-cols-12">
                <div className="flex flex-col gap-2 lg:col-span-3">
                  <h3 id={`dept-${dept}`} className="font-mono text-[12px] uppercase text-fg-2">{DEPARTMENT_LABEL[dept]}</h3>
                  <p className="t-small max-w-[34ch] text-muted">{DEPT_BLURB[dept]}</p>
                </div>
                <ul className={`grid gap-4 lg:col-span-9 ${dept === "leadership" ? "" : "sm:grid-cols-2"}`}>
                  {nodes.map((n: PublicAgentNode) => (
                    <li key={n.id} className="min-w-0">
                      <AgentCard node={n} byId={byId} now={now} available={chart.activityAvailable} lead={dept === "leadership"} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </Section>

        <Section labelledBy="gates-h">
          <div className="grid gap-12 lg:grid-cols-12">
            <div className="flex flex-col gap-4 lg:col-span-5">
              <Eyebrow>Human approval gates</Eyebrow>
              <h2 id="gates-h" className="t-h2 text-balance">Agents draft. <span className="text-muted">Humans decide.</span></h2>
              <p className="t-lead max-w-[44ch]">These rules are enforced in code, not just in policy. Agents that contact people are off until a founder switches them on.</p>
            </div>
            <div className="flex flex-col gap-10 lg:col-span-7">
              <ol className="flex flex-col">
                {HUMAN_GATES.map((g, i) => (
                  <li key={g} className="flex gap-5 border-t border-line-2 py-4 first:border-t-0 first:pt-0">
                    <span aria-hidden className="font-mono text-[12px] text-subtle tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                    <span className="text-[15px] text-fg-2">{g}</span>
                  </li>
                ))}
              </ol>
              <div className="flex flex-col gap-4">
                <h3 className="font-mono text-[12px] uppercase text-fg-2">Agents that can reach people</h3>
                <ul className="flex flex-col gap-4">
                  {gated.map((a) => (
                    <li key={a.id} className="rounded-[4px] border border-line-2 bg-bg-raised p-4">
                      <p className="text-fg">{a.name}</p>
                      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 marker:text-line-3">
                        {a.gates.map((g) => <li key={g} className="t-small text-muted">{g}</li>)}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </Section>

        <Section band labelledBy="cta-company-h" className="!py-16 md:!py-24">
          <Container className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <h2 id="cta-company-h" className="t-h2 max-w-[22ch] text-balance">Want agents like these <span className="text-muted">tested properly?</span></h2>
            <Button href="/pricing" size="lg">See pricing <NudgeArrow size={18} /></Button>
          </Container>
        </Section>
      </main>
      <Footer />
    </div>
  );
}

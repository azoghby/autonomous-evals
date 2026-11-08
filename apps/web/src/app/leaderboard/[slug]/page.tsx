import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CodeBlock, Eyebrow, Frame, PageShell, Stat } from "@/components/ui";
import { getAgentDetail } from "@/server/leaderboard-db";
import { SUITE_VERSION, categoryLabel, percent, rate, REDTEAM_CATEGORY_PREFIX } from "@/server/leaderboard";
import { KindTag, LEADERBOARD_NAV, RateBar, SEVERITY_TEXT, SeverityDot, fmtDate } from "../parts";
import { Methodology } from "../Methodology";

export const revalidate = 300;
type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const d = await getAgentDetail(slug);
  if (!d) return { title: "Agent not found · Standard Evals", robots: { index: false } };
  return { title: `${d.entry.name} · Leaderboard · Standard Evals`, description: `${d.entry.name} scored ${percent(d.entry.passRate)} on the ${SUITE_VERSION} suite (rank ${d.entry.rank} of ${d.totalRanked}).` };
}

const SITE = (process.env.APP_URL ?? "").replace(/\/$/, "");

export default async function AgentPage({ params }: Params) {
  const { slug } = await params;
  const d = await getAgentDetail(slug);
  if (!d) notFound();
  const { entry: e, agent } = d;
  const cats = Object.entries(e.run.byCategory);
  const designed = cats.filter(([k]) => !k.startsWith(REDTEAM_CATEGORY_PREFIX));
  const redteam = cats.filter(([k]) => k.startsWith(REDTEAM_CATEGORY_PREFIX));
  const top = e.run.findings.slice(0, 8);
  const url = `${SITE}/leaderboard/${slug}`;
  const md = `[![Standard Evals](${url}/badge.svg)](${url})`;

  const group = (title: string, rows: typeof cats) => rows.length > 0 && (
    <div>
      <h3 className="font-mono text-[11px] uppercase text-subtle">{title}</h3>
      <ul className="mt-4 divide-y divide-line">
        {rows.map(([k, v]) => (
          <li key={k} className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-2 py-3 sm:grid-cols-[220px_1fr_auto]">
            <span className="text-[14px] text-fg-2">{categoryLabel(k)}</span>
            <RateBar value={rate(v.passed, v.total)} label={categoryLabel(k)} className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto" />
            <span className="t-data text-subtle">{v.passed}/{v.total}</span>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <PageShell nav={LEADERBOARD_NAV} active="/leaderboard">
      <nav aria-label="Breadcrumb"><Link href="/leaderboard" className="t-small text-muted hover:text-fg">&larr; Leaderboard</Link></nav>
      <Eyebrow className="mt-8">Rank {e.rank} of {d.totalRanked}</Eyebrow>
      <h1 className="t-h1 mt-5 text-fg">{e.name}</h1>
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[14px] text-muted">
        <span>{e.vendor}</span><KindTag kind={e.kind} /><span className="t-data">{agent.model}</span>
        {agent.homepage && <a href={agent.homepage} rel="noopener noreferrer nofollow" className="text-accent-text underline underline-offset-4">Homepage</a>}
      </div>

      <dl className="mt-12 grid grid-cols-2 gap-px border border-line-2 bg-line-2 md:grid-cols-4">
        {[
          ["Pass rate", percent(e.passRate), `${e.run.passed} of ${e.run.total} scenarios`],
          ["Red-team", e.redTeamRate === null ? "n/a" : percent(e.redTeamRate), "attack scenarios passed"],
          ["Critical findings", String(e.criticalCount), "failed critical scenarios"],
          ["Last run", fmtDate(e.run.ranAt), `suite ${e.run.suiteVersion}`],
        ].map(([k, v, h]) => <div key={k} className="bg-bg p-5"><dt className="sr-only">{k}</dt><dd><Stat label={k!} value={v} hint={h} /></dd></div>)}
      </dl>

      <section aria-labelledby="cat-h" className="mt-16">
        <h2 id="cat-h" className="t-h3 text-fg">Results by category</h2>
        <div className="mt-8 grid gap-12 lg:grid-cols-2">{group("Capability", designed)}{group("Red-team", redteam)}</div>
      </section>

      <section aria-labelledby="find-h" className="mt-16">
        <h2 id="find-h" className="t-h3 text-fg">Top findings</h2>
        {top.length === 0 ? (
          <p className="mt-4 text-[14px] text-muted">No failed scenarios in the latest run.</p>
        ) : (
          <Frame className="mt-6 bg-bg-raised">
            <ul className="divide-y divide-line">
              {top.map((f, i) => (
                <li key={i} className="px-5 py-4">
                  <p className="flex items-center gap-2 text-[15px] text-fg"><SeverityDot severity={f.severity} />{f.title}</p>
                  <p className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[11px] uppercase text-subtle">
                    <span className={SEVERITY_TEXT[f.severity]}>{f.severity}</span><span>{f.scenarioId ?? f.category}</span>
                  </p>
                  {f.excerpt && <p className="mt-2 border-l border-line-3 pl-3 font-mono text-[12px] leading-[1.5] text-muted">{f.excerpt}</p>}
                </li>
              ))}
            </ul>
          </Frame>
        )}
        {e.run.findings.length > top.length && <p className="t-small mt-3 text-subtle">+ {e.run.findings.length - top.length} more lower-severity findings</p>}
      </section>

      {d.history.length > 1 && (
        <section aria-labelledby="hist-h" className="mt-16">
          <h2 id="hist-h" className="t-h3 text-fg">History</h2>
          <ol className="t-data mt-4 flex flex-wrap gap-x-6 gap-y-2 text-muted">
            {d.history.map((h, i) => <li key={i}>{fmtDate(h.ranAt)} <span className="text-fg">{percent(h.passRate)}</span></li>)}
          </ol>
        </section>
      )}

      <section aria-labelledby="badge-h" className="mt-16 max-w-3xl">
        <h2 id="badge-h" className="t-h3 text-fg">Badge</h2>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/leaderboard/${slug}/badge.svg`} alt={`Standard Evals badge for ${e.name}`} height={20} className="mt-4 h-5" />
        <CodeBlock label="Markdown" code={md} className="mt-4" />
      </section>

      <Methodology />
    </PageShell>
  );
}

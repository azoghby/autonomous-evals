import type { Metadata } from "next";
import Link from "next/link";
import { Eyebrow, Frame, PageShell, Reveal } from "@/components/ui";
import { getLeaderboard } from "@/server/leaderboard-db";
import { SUITE_VERSION, percent, type RankedEntry } from "@/server/leaderboard";
import { suiteCounts } from "@/server/leaderboard-suite";
import { KindTag, LEADERBOARD_NAV, RateBar, Th, fmtDate } from "./parts";
import { Methodology } from "./Methodology";
import { AgentMatrixTable } from "./AgentMatrix";
import { buildAgentMatrix } from "@/server/leaderboard-matrix";

export const revalidate = 300;
export const metadata: Metadata = {
  title: "Public agent leaderboard · Standard Evals",
  description: "Public AI agents ranked on one frozen evaluation suite: everyday tasks, instruction following and red-team safety.",
};

function Row({ e }: { e: RankedEntry }) {
  return (
    <tr className="border-t border-line transition-colors duration-150 hover:bg-bg-hover">
      <td className="t-data w-12 px-4 py-4 text-subtle">{String(e.rank).padStart(2, "0")}</td>
      <td className="px-4 py-4">
        <Link href={`/leaderboard/${e.slug}`} className="group text-[15px] text-fg underline-offset-4 hover:underline focus-visible:underline">{e.name}</Link>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-muted"><span>{e.vendor}</span><KindTag kind={e.kind} /></div>
      </td>
      <td className="w-56 px-4 py-4"><RateBar value={e.passRate} label="Pass rate" /></td>
      <td className="hidden w-48 px-4 py-4 md:table-cell">{e.redTeamRate === null ? <span className="t-data text-subtle">n/a</span> : <RateBar value={e.redTeamRate} label="Red-team pass rate" />}</td>
      <td className="t-data hidden w-24 px-4 py-4 text-right sm:table-cell">
        <span className={e.criticalCount > 0 ? "text-danger" : "text-fg-2"}>{e.criticalCount}</span>
      </td>
      <td className="t-data hidden w-28 px-4 py-4 text-right text-muted lg:table-cell">{fmtDate(e.run.ranAt)}</td>
    </tr>
  );
}

export default async function LeaderboardPage() {
  const { entries, ok } = await getLeaderboard();
  const c = suiteCounts();
  const matrix = buildAgentMatrix(entries.filter((e) => e.kind === "local_reference"));
  return (
    <PageShell nav={LEADERBOARD_NAV} active="/leaderboard">
      <Reveal>
        <Eyebrow>Leaderboard</Eyebrow>
        <h1 className="t-h1 mt-5 max-w-4xl text-fg">Public agents, one suite. <span className="text-muted">Ranked on tasks, instructions and red-team safety.</span></h1>
        <p className="t-lead mt-6 max-w-2xl">{c.total} frozen scenarios, deterministic graders, the same budget for every agent. <a href="#methodology" className="text-accent-text underline underline-offset-4">How we score</a>.</p>
        <p className="mt-3 text-[15px]"><Link href="/leaderboard/submit" className="text-accent-text underline underline-offset-4">Submit your agent</Link></p>
      </Reveal>

      {matrix.rows.length > 0 && (
        <>
          <Frame className="mt-14 bg-bg-raised" aria-labelledby="matrix-h">
            <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-4 py-4">
              <h2 id="matrix-h" className="t-h3 text-fg">Open-source agents × models</h2>
              <p className="text-[13px] text-muted">{matrix.rows.length} agents · {matrix.columns.length} models · click a header to sort, a score to open the run</p>
            </div>
            <AgentMatrixTable matrix={matrix} />
          </Frame>
          <p className="t-small mt-4 text-subtle">Each agent is a public sample under an OSI licence (MIT or Apache-2.0), run unmodified from a pinned commit on our machine. Only its model client is pointed at our AI Gateway account. These are not vendor-hosted products. A <span className="text-danger">!</span> marks a run with a critical failure.</p>
        </>
      )}

      <Frame className="mt-14 bg-bg-raised" aria-labelledby="board-h">
        <h2 id="board-h" className="t-h3 border-b border-line px-4 py-4 text-fg">All runs, ranked<span className="sr-only">, suite {SUITE_VERSION}</span></h2>
        <h2 id="board-h" className="sr-only">Ranking, suite {SUITE_VERSION}</h2>
        {entries.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="font-mono text-[11px] uppercase text-subtle">{ok ? "No runs yet" : "Results unavailable"}</p>
            <p className="t-h3 mx-auto mt-4 max-w-md text-fg">{ok ? "The first agents are being evaluated now." : "We could not load results right now."}</p>
            <p className="mx-auto mt-3 max-w-md text-[14px] text-muted">{ok ? `Scores appear here as each agent completes the ${SUITE_VERSION} suite. Check back soon.` : "Try again in a few minutes."}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse">
              <caption className="sr-only">Agents ranked by pass rate on suite {SUITE_VERSION}</caption>
              <thead><tr>
                <Th>#</Th><Th>Agent</Th><Th>Pass rate</Th><Th className="hidden md:table-cell">Red-team</Th>
                <Th className="hidden text-right sm:table-cell">Critical</Th><Th className="hidden text-right lg:table-cell">Last run</Th>
              </tr></thead>
              <tbody>{entries.map((e) => <Row key={e.slug} e={e} />)}</tbody>
            </table>
          </div>
        )}
      </Frame>
      <p className="t-small mt-4 text-subtle">Suite {SUITE_VERSION}. Every run: one agent on one model, same scenarios, same budget.</p>

      <Methodology />
    </PageShell>
  );
}

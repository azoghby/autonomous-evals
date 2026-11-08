import type { CSSProperties } from "react";
import Link from "next/link";
import { getLeaderboard } from "@/server/leaderboard-db";
import { percent } from "@/server/leaderboard";
import { suiteCounts } from "@/server/leaderboard-suite";
import { Button, Eyebrow, NudgeArrow, Reveal, Section } from "../ui";
import { InViewGroup } from "./InViewGroup";

const TICKS = [25, 50, 75];
const TOP_N = 5;

function VerifiedBadge() {
  return (
    <span className="lb-badge">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 .8 10.5 2.6v3.2c0 2.6-1.8 4.3-4.5 5.4C3.3 10.1 1.5 8.4 1.5 5.8V2.6L6 .8Z" stroke="currentColor" strokeWidth="1" /><path d="m3.9 6 1.5 1.5L8.2 4.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      Leader
    </span>
  );
}

/** Landing teaser for the public leaderboard: live top 5 from the DB (page uses ISR). Empty state when no runs yet. */
export async function LeaderboardTeaser() {
  const { entries } = await getLeaderboard();
  const top = entries.slice(0, TOP_N);
  const c = suiteCounts();
  return (
    <Section id="leaderboard" labelledBy="lb-h" band className="relative overflow-hidden scroll-mt-16">
      <div className="grid gap-12 lg:grid-cols-12 lg:gap-16">
        <Reveal className="flex flex-col gap-6 lg:col-span-4">
          <Eyebrow>Leaderboard</Eyebrow>
          <h2 id="lb-h" className="t-h2 text-balance text-fg">Public agents, one suite. <span className="text-muted">Re-tested on a schedule.</span></h2>
          <p className="t-lead max-w-[28rem]">{c.total} frozen scenarios, {c.redTeam} of them red-team. Submit yours and our agents run it.</p>
          <div className="flex flex-wrap gap-3">
            <Button href="/leaderboard" variant="outline" className="group">See the leaderboard <NudgeArrow /></Button>
            <Button href="/leaderboard/submit" variant="quiet" className="group">Submit your agent <NudgeArrow /></Button>
          </div>
        </Reveal>
        <div className="min-w-0 lg:col-span-8">
          {top.length > 0 ? (
            <InViewGroup className="relative">
              <div className="lb-glow" aria-hidden="true" />
              <ol className="relative divide-y divide-line rounded-[4px] border border-line-2 bg-bg/60">
                {top.map((e, i) => (
                  <li key={e.slug} className={i === 0 ? "lb-top" : undefined}>
                    <Link href={`/leaderboard/${e.slug}`} className="lb-row" style={{ "--i": i, "--p": e.passRate } as CSSProperties}>
                      <span className="lb-rank">{String(e.rank).padStart(2, "0")}</span>
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="truncate text-[15px] text-fg md:text-base">{e.name}</span>
                          {i === 0 ? <VerifiedBadge /> : null}
                        </span>
                        <span className="lb-track" aria-hidden="true">
                          <span className="lb-fill" />
                          {TICKS.map((t) => <span key={t} className="lb-tick" style={{ left: `${t}%` }} />)}
                        </span>
                      </span>
                      <span className={`lb-val ${i === 0 ? "text-fg" : "text-fg-2"}`}>{percent(e.passRate)}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            </InViewGroup>
          ) : (
            <p className="rounded-[4px] border border-line-2 bg-bg/60 px-6 py-8 font-mono text-[12px] uppercase text-subtle">First runs are being scheduled. Rankings appear here once they finish.</p>
          )}
        </div>
      </div>
    </Section>
  );
}

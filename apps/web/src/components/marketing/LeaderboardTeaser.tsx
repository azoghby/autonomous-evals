import Link from "next/link";
import { getLeaderboard } from "@/server/leaderboard-db";
import { percent } from "@/server/leaderboard";
import { Button, NudgeArrow, Section, SectionHeader } from "../ui";
import { InViewGroup } from "./InViewGroup";
import { AutopilotLoop } from "./leaderboard-autopilot/AutopilotLoop";

const TICKS = [25, 50, 75];

function VerifiedBadge() {
  return (
    <span className="lb-badge">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M6 .8 10.5 2.6v3.2c0 2.6-1.8 4.3-4.5 5.4C3.3 10.1 1.5 8.4 1.5 5.8V2.6L6 .8Z" stroke="currentColor" strokeWidth="1" /><path d="m3.9 6 1.5 1.5L8.2 4.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      Verified
    </span>
  );
}

/** Landing-page teaser for the public leaderboard (async server component; page uses ISR). Still renders (autopilot loop + submit CTA) when there are no runs yet. */
export async function LeaderboardTeaser() {
  const { entries } = await getLeaderboard();
  const top = entries.slice(0, 5);
  return (
    <Section id="leaderboard" labelledBy="lb-h" band className="relative overflow-hidden">
      <SectionHeader id="lb-h" index="09" eyebrow="Leaderboard" title={<>Reference agents, re-tested every day. <span className="text-muted">Same suite, same graders. Submit yours and our agents run it.</span></>} />
      {top.length > 0 ? (
        <InViewGroup className="relative mt-12">
          <div className="lb-glow" aria-hidden="true" />
          <ol className="relative divide-y divide-line border border-line-2 bg-bg/60">
            {top.map((e, i) => (
              <li key={e.slug} className={i === 0 ? "lb-top" : undefined}>
                <Link href={`/leaderboard/${e.slug}`} className="lb-row" style={{ "--i": i, "--p": e.passRate } as React.CSSProperties}>
                  <span className="lb-rank">{String(e.rank).padStart(2, "0")}</span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-[15px] text-fg md:text-base">{e.name}</span>
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
        <p className="mt-12 border border-line-2 bg-bg/60 px-6 py-8 font-mono text-[12px] uppercase text-subtle">First daily runs are being scheduled. Rankings appear here once they finish.</p>
      )}
      <AutopilotLoop />
      <div className="mt-12 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button href="/leaderboard/submit" className="group">Submit your agent <NudgeArrow /></Button>
          <Button href="/leaderboard" variant="outline" className="group">See the full leaderboard <NudgeArrow /></Button>
        </div>
        <p className="font-mono text-[11px] uppercase text-subtle">
          32 scenarios · 24 red-team attacks · <Link href="/leaderboard#methodology" className="text-fg-2 underline decoration-accent underline-offset-4 hover:text-fg">open methodology</Link>
        </p>
      </div>
    </Section>
  );
}

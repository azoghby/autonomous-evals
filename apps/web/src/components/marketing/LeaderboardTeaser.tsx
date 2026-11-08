import Link from "next/link";
import { getLeaderboard } from "@/server/leaderboard-db";
import { percent } from "@/server/leaderboard";
import { Button, NudgeArrow, Section, SectionHeader } from "../ui";

/** Landing-page teaser for the public leaderboard (async server component; page uses ISR). Renders nothing until there are runs. */
export async function LeaderboardTeaser() {
  const { entries } = await getLeaderboard();
  if (entries.length === 0) return null;
  const top = entries.slice(0, 3);
  return (
    <Section id="leaderboard" labelledBy="lb-h" band>
      <SectionHeader id="lb-h" index="07" eyebrow="Leaderboard" title={<>Public agents, ranked on one suite. <span className="text-muted">Same prompts, same graders, open methodology.</span></>} />
      <ol className="mt-12 divide-y divide-line border border-line-2">
        {top.map((e) => (
          <li key={e.slug}>
            <Link href={`/leaderboard/${e.slug}`} className="flex items-baseline gap-4 px-5 py-4 transition-colors hover:bg-bg-hover">
              <span className="t-data w-8 text-subtle">{String(e.rank).padStart(2, "0")}</span>
              <span className="flex-1 text-[15px] text-fg">{e.name}</span>
              <span className="t-data text-fg">{percent(e.passRate)}</span>
            </Link>
          </li>
        ))}
      </ol>
      <Button href="/leaderboard" variant="outline" className="mt-8 group">See the full leaderboard <NudgeArrow /></Button>
    </Section>
  );
}

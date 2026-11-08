import Link from "next/link";
import { getHomeStats } from "@/server/home-stats";
import { Container } from "../ui";

const DATE_FMT = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const INT_FMT = new Intl.NumberFormat("en-US");

function usd(n: number): string {
  return `$${n.toFixed(n < 0.01 ? 5 : 4)}`;
}

/** Compact proof strip: real read-only numbers from the public leaderboard tables. Renders nothing when the DB is unavailable. */
export async function ProofStats() {
  const s = await getHomeStats();
  if (!s) return null;
  const items: Array<{ label: string; value: string }> = [
    { label: "Leaderboard agents", value: INT_FMT.format(s.agents) },
    { label: "Model pairings run", value: INT_FMT.format(s.pairings) },
    { label: "Scenarios graded", value: INT_FMT.format(s.scenarios) },
    ...(s.medianCostPerScenarioUsd != null ? [{ label: "Median cost / scenario", value: usd(s.medianCostPerScenarioUsd) }] : []),
  ];
  return (
    <section aria-label="Leaderboard proof" className="proof-strip border-t border-line-2 bg-bg">
      <Container>
        <Link href="/leaderboard" className="proof-link">
          <dl className="proof-grid">
            {items.map((i) => (
              <div key={i.label} className="proof-item">
                <dt className="proof-label">{i.label}</dt>
                <dd className="proof-value">{i.value}</dd>
              </div>
            ))}
          </dl>
          <span className="proof-asof">As of {DATE_FMT.format(new Date(s.asOf))} UTC · see the leaderboard →</span>
        </Link>
      </Container>
    </section>
  );
}

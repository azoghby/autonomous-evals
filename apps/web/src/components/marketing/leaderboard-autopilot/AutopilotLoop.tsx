import Link from "next/link";
import { InViewGroup } from "../InViewGroup";

/** Copy mirrors what the code does: submit page + consent, emailed confirm link (verify), standard/red-team suites, results email, owner reply responder. */
const STEPS = [
  ["Submit", "Owner adds an endpoint and consents."],
  ["Verify", "Confirm link by email. Nothing runs before it."],
  ["Test", "Red-team and standard suites run."],
  ["Results email", "Scores and findings land in the inbox."],
  ["Reply handled", "Replies answered. Follow-ups only on real changes."],
] as const;

/** Autopilot loop: 5 real-text nodes on a hairline with a traveling pulse. Server component; lights up via InViewGroup attribute selectors (ap-* in globals.css). */
export function AutopilotLoop() {
  return (
    <InViewGroup className="ap-loop mt-12" threshold={0.3}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p className="font-mono text-[11px] uppercase text-subtle">Owner autopilot</p>
        <p className="ap-live font-mono text-[11px] uppercase text-fg-2">
          <span className="ap-dot" aria-hidden="true" />Reference agents daily · yours weekly
        </p>
      </div>
      <div className="ap-wrap">
        <div className="ap-rail" aria-hidden="true"><span className="ap-pulse" /></div>
        <ol className="ap-steps">
          {STEPS.map(([label, line], i) => (
            <li key={label} className="ap-step" style={{ "--i": i } as React.CSSProperties}>
              <span className="ap-node" aria-hidden="true" />
              <span className="ap-label font-mono">{String(i + 1).padStart(2, "0")} {label}</span>
              <span className="ap-line">{line}</span>
            </li>
          ))}
        </ol>
      </div>
      <p className="mt-6 font-mono text-[11px] uppercase text-subtle">
        Consent first · one-click unsubscribe in every email · <Link href="/leaderboard/submit#consent" className="text-fg-2 underline decoration-accent underline-offset-4 hover:text-fg">what you agree to</Link>
      </p>
    </InViewGroup>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Eyebrow, PageShell } from "@/components/ui";
import { LEADERBOARD_NAV } from "../parts";

export const metadata: Metadata = { title: "Unsubscribed · Standard Evals", robots: { index: false, follow: false } };

export default function UnsubscribedPage() {
  return (
    <PageShell nav={LEADERBOARD_NAV} active="/leaderboard">
      <Eyebrow className="mt-8">Unsubscribed</Eyebrow>
      <h1 className="t-h1 mt-5 text-fg">You will not get non-essential emails from us.</h1>
      <div className="mt-6 max-w-2xl space-y-4 text-[15px] text-muted">
        <p>We have stopped follow-up and re-run notification emails to this address.</p>
        <p>
          This does not pause testing: your agent keeps being tested on the usual schedule, and results stay available.
          To stop testing and delete your agent and its results, reply &quot;opt out&quot; to any email from us.
        </p>
        <p><Link href="/leaderboard" className="text-accent-text underline underline-offset-4">Back to the leaderboard</Link></p>
      </div>
    </PageShell>
  );
}

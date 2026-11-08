import { Eyebrow, PageShell } from "@/components/ui";
import { Confirm } from "./confirm";

export const metadata = { title: "Confirm your agent · Standard Evals", robots: { index: false, follow: false } };

type Params = { params: Promise<{ token: string }> };

/** Rendering never verifies: email link scanners prefetch GETs. Only the button's POST does. */
export default async function VerifyPage({ params }: Params) {
  const { token } = await params;
  return (
    <PageShell active="/leaderboard">
      <section aria-labelledby="verify-heading" className="max-w-[56ch]">
        <Eyebrow>Leaderboard</Eyebrow>
        <h1 id="verify-heading" className="t-h1 mt-6 text-balance">Confirm your agent</h1>
        <p className="t-lead mt-6">
          Press Confirm to start automated testing of the agent you submitted. Our AI agents will run a red-team and a
          standard suite, email you the results, and re-run weekly. You can opt out anytime.
        </p>
        <div className="mt-10"><Confirm token={token} /></div>
      </section>
    </PageShell>
  );
}

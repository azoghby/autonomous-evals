import { Eyebrow, PageShell } from "@/components/ui";
import { CONSENT_AUTHORIZE_TEXT, CONSENT_EMAILS_TEXT } from "@/server/owner-policy";
import { SubmitForm } from "./submit-form";

export const metadata = {
  title: "Submit your agent · Standard Evals",
  description: "Get your AI agent tested by autonomous agents: red-team and standard suites, results by email, weekly re-runs. Opt out anytime.",
};

const STEPS = [
  ["You submit and confirm", "We email a confirm link. Nothing runs until you press Confirm."],
  ["Our agents test it", "Autonomous agents run a red-team suite and the standard test suite against your endpoint."],
  ["Results by email", "You get the scores and findings. Public agents also appear on the leaderboard; private ones stay with you."],
  ["Weekly re-runs", "We re-test weekly and email you only when something meaningful changes. Any fix offer is optional."],
  ["Opt out anytime", "Every email has a one-click unsubscribe, and you can reply to pause runs, go private, or opt out."],
] as const;

export default function SubmitAgentPage() {
  return (
    <PageShell active="/leaderboard">
      <section aria-labelledby="submit-heading">
        <Eyebrow>Leaderboard</Eyebrow>
        <h1 id="submit-heading" className="t-h1 mt-6 max-w-[20ch] text-balance">
          Submit your agent. <span className="text-muted">Autonomous agents will test it.</span>
        </h1>
        <p className="t-lead mt-6 max-w-[68ch]">
          Standard Evals is run by AI agents supervised by human founders. Every message we send says so. You only
          submit an agent you own or are authorized to test.
        </p>
      </section>
      <section aria-labelledby="how-heading" className="mt-20 grid gap-14 border-t border-line-2 pt-12 lg:grid-cols-12 lg:gap-x-8">
        <div className="lg:col-span-5">
          <h2 id="how-heading" className="t-h3 text-fg">What happens next</h2>
          <ol className="mt-8 border-t border-line-2">
            {STEPS.map(([t, d]) => (
              <li key={t} className="border-b border-line-2 py-5">
                <p className="t-h4 text-fg">{t}</p>
                <p className="t-body mt-2 max-w-[56ch] text-muted">{d}</p>
              </li>
            ))}
          </ol>
          <div id="consent" className="mt-10 scroll-mt-24">
            <h2 className="t-h4 text-fg">What you agree to</h2>
            <ul className="t-body mt-3 list-disc space-y-2 pl-5 text-muted">
              <li>{CONSENT_AUTHORIZE_TEXT}</li>
              <li>{CONSENT_EMAILS_TEXT}</li>
            </ul>
            <p className="t-body mt-3 text-muted">Your API key, if you add one, is encrypted at rest and used only to run these tests.</p>
          </div>
        </div>
        <div className="lg:col-span-6 lg:col-start-7">
          <SubmitForm authorizeText={CONSENT_AUTHORIZE_TEXT} emailsText={CONSENT_EMAILS_TEXT} />
        </div>
      </section>
    </PageShell>
  );
}

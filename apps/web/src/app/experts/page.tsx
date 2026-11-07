import { Eyebrow, PageShell, Stat } from "@/components/ui";
import { SignupForm } from "./signup-form";

export const metadata = {
  title: "Get paid to review AI agents · Standard Evals",
  description: "Working professionals answer short questions about their field and get paid. Opt in once, opt out anytime.",
};


const RATES = [
  { value: "$25", label: "Short async questions", hint: "A handful of written questions, answered when it suits you." },
  { value: "$75", label: "15-minute call", hint: "Pilot rate. Recorded only if you say yes, twice." },
] as const;

const NOTES = [
  ["What we use your answers for", "Reference answers and scoring criteria for evaluations of AI agents in your domain. Answers are stored by us and never shown to customers with your name unless you allow it."],
  ["AI agents are involved", "Standard Evals is run by AI agents supervised by human founders. Any message we send says so, and a founder approves each first contact."],
  ["Opt out anytime", "Every email has a one-click opt-out. It adds you to a do-not-contact list we check before every send."],
  ["Payment", "Honoraria are paid manually in the pilot, after you submit."],
] as const;

export default function ExpertsPage() {
  return (
    <PageShell active="/experts">
      <section aria-labelledby="experts-heading">
        <Eyebrow>Paid pilot</Eyebrow>
        <h1 id="experts-heading" className="t-h1 mt-6 max-w-[20ch] text-balance">
          Get paid to review AI agents in your field.{" "}
          <span className="text-muted">Short questions, paid, opt out anytime.</span>
        </h1>
        <p className="t-lead mt-6 max-w-[68ch]">
          We test AI agents for legal, clinical, insurance, accounting and more. Our agents can write the tests, but only
          someone who does the work can say what correct looks like. That is where you come in.
        </p>
        <dl className="mt-12 grid max-w-[880px] border border-line-2 sm:grid-cols-2 sm:divide-x sm:divide-line-2">
          {RATES.map((r) => (
            <div key={r.value} className="border-b border-line-2 p-6 last:border-b-0 sm:border-b-0 sm:p-8">
              <dt className="sr-only">{r.label}</dt>
              <dd>
                <Stat label={r.label} value={r.value} hint={r.hint} />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="honest-heading" className="mt-24 grid gap-14 border-t border-line-2 pt-12 sm:mt-32 lg:grid-cols-12 lg:gap-x-8">
        <div className="lg:col-span-5">
          <Eyebrow>Before you join</Eyebrow>
          <h2 id="honest-heading" className="t-h3 mt-6 text-fg">How this works, plainly</h2>
          <dl className="mt-8 border-t border-line-2">
            {NOTES.map(([t, d]) => (
              <div key={t} className="border-b border-line-2 py-5">
                <dt className="t-h4 text-fg">{t}</dt>
                <dd className="t-body mt-2 max-w-[56ch] text-muted">{d}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="lg:col-span-6 lg:col-start-7">
          <SignupForm />
        </div>
      </section>
    </PageShell>
  );
}

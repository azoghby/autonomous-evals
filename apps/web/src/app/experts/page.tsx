import { CountUp, DrawRule, PageShell, Reveal, Stagger, StaggerItem } from "@/components/ui";
import { SignupForm } from "./signup-form";

export const metadata = {
  title: "Get paid to review AI agents · Autonomous Evals",
  description: "Working professionals answer short questions about their field and get paid. Opt in once, opt out anytime.",
};

const NAV = [{ label: "Experts", href: "/experts" }];

const FACTS = [
  { k: 25, v: "Short async questions", d: "A handful of written questions, answered when it suits you." },
  { k: 75, v: "15-minute call", d: "Pilot rate. Recorded only if you say yes, twice." },
] as const;

const NOTES = [
  ["What we use your answers for", "Reference answers and scoring criteria for evaluations of AI agents in your domain. Answers are stored by us and never shown to customers with your name unless you allow it."],
  ["AI agents are involved", "Autonomous Evals is run by AI agents supervised by human founders. Any message we send says so, and a founder approves each first contact."],
  ["Opt out anytime", "Every email has a one-click opt-out. It adds you to a do-not-contact list we check before every send."],
  ["Payment", "Honoraria are paid manually in the pilot, after you submit."],
] as const;

export default function ExpertsPage() {
  return (
    <PageShell nav={NAV} active="/experts">
      <section aria-labelledby="experts-heading" className="pb-12 pt-10 sm:pt-16">
        <Reveal className="max-w-3xl">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-cream/45">Paid pilot</p>
          <h1 id="experts-heading" className="text-balance mt-4 text-5xl font-medium leading-[0.98] tracking-[-0.04em] sm:text-7xl">
            Get paid to review AI agents in your field
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-cream/65 sm:text-lg">
            We test AI agents for legal, clinical, insurance, accounting and more. Our agents can write the tests, but only
            someone who does the work can say what correct looks like. That is where you come in.
          </p>
        </Reveal>
      </section>

      <div className="text-cream/15"><DrawRule /></div>
      <Stagger className="grid sm:grid-cols-2 sm:divide-x sm:divide-cream/10">
        {FACTS.map((f, i) => (
          <StaggerItem key={f.k} className={`py-8 ${i === 1 ? "sm:pl-8" : "sm:pr-8"}`}>
            <p className="text-5xl font-medium tracking-tight text-coral"><CountUp value={f.k} prefix="$" /></p>
            <h2 className="mt-3 text-lg font-medium">{f.v}</h2>
            <p className="mt-1 text-sm text-cream/60">{f.d}</p>
          </StaggerItem>
        ))}
      </Stagger>
      <div className="text-cream/15"><DrawRule /></div>

      <section aria-labelledby="honest-heading" className="mt-14 grid gap-12 lg:grid-cols-5">
        <Reveal className="lg:col-span-2">
          <h2 id="honest-heading" className="text-2xl font-medium tracking-tight">How this works, plainly</h2>
          <dl className="mt-6 divide-y divide-cream/10 text-sm">
            {NOTES.map(([t, d]) => (
              <div key={t} className="py-4 first:pt-0"><dt className="font-medium text-cream">{t}</dt>
                <dd className="mt-1 text-cream/60">{d}</dd></div>
            ))}
          </dl>
        </Reveal>
        <Reveal delay={0.1} className="lg:col-span-3">
          <SignupForm />
        </Reveal>
      </section>
    </PageShell>
  );
}

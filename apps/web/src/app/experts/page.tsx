import { PageShell, RibbedGlow, Chip, GlassCard } from "@/components/ui";
import { SignupForm } from "./signup-form";

export const metadata = {
  title: "Get paid to review AI agents · Autonomous Evals",
  description: "Working professionals answer short questions about their field and get paid. Opt in once, opt out anytime.",
};

const NAV = [{ label: "Experts", href: "/experts" }];

const FACTS = [
  { k: "$25", v: "Short async questions", d: "A handful of written questions, answered when it suits you." },
  { k: "$75", v: "15-minute call", d: "Pilot rate. Recorded only if you say yes, twice." },
] as const;

export default function ExpertsPage() {
  return (
    <PageShell nav={NAV} active="/experts">
      <section aria-labelledby="experts-heading" className="relative isolate overflow-hidden rounded-[2rem] bg-navy px-6 py-12 sm:px-10 sm:py-14">
        <RibbedGlow />
        <div className="relative z-10 max-w-2xl">
          <Chip tone="coral" dot>Paid pilot</Chip>
          <h1 id="experts-heading" className="text-balance mt-5 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">
            Get paid to review AI agents in your field
          </h1>
          <p className="mt-4 max-w-xl text-base text-cream/75">
            We test AI agents for legal, clinical, insurance, accounting and more. Our agents can write the tests, but only
            someone who does the work can say what correct looks like. That is where you come in.
          </p>
        </div>
      </section>

      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {FACTS.map((f) => (
          <GlassCard key={f.k} className="p-6">
            <p className="text-4xl font-semibold tracking-tight text-coral">{f.k}</p>
            <h2 className="mt-2 text-lg font-medium">{f.v}</h2>
            <p className="mt-1 text-sm text-cream/65">{f.d}</p>
          </GlassCard>
        ))}
      </div>

      <section aria-labelledby="honest-heading" className="mt-10 grid gap-8 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-2">
          <h2 id="honest-heading" className="text-2xl font-semibold tracking-tight">How this works, plainly</h2>
          <dl className="space-y-5 text-sm">
            <div><dt className="font-medium text-cream">What we use your answers for</dt>
              <dd className="mt-1 text-cream/65">Reference answers and scoring criteria for evaluations of AI agents in your domain. Answers are stored by us and never shown to customers with your name unless you allow it.</dd></div>
            <div><dt className="font-medium text-cream">AI agents are involved</dt>
              <dd className="mt-1 text-cream/65">Autonomous Evals is run by AI agents supervised by human founders. Any message we send says so, and a founder approves each first contact.</dd></div>
            <div><dt className="font-medium text-cream">Opt out anytime</dt>
              <dd className="mt-1 text-cream/65">Every email has a one-click opt-out. It adds you to a do-not-contact list we check before every send.</dd></div>
            <div><dt className="font-medium text-cream">Payment</dt>
              <dd className="mt-1 text-cream/65">Honoraria are paid manually in the pilot, after you submit.</dd></div>
          </dl>
        </div>
        <div className="lg:col-span-3">
          <SignupForm />
        </div>
      </section>
    </PageShell>
  );
}

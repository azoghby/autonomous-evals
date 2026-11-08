import type { Metadata } from "next";
import { Eyebrow, PageShell } from "@/components/ui";
import { Footer } from "@/components/marketing/Footer";
import { ContactSalesForm } from "./ContactSalesForm";

export const metadata: Metadata = {
  title: "Talk to us · Standard Evals",
  description: "Enterprise evals: we build your environment from your APIs, data and policies, with domain-expert reviewers and volume pricing.",
};

const POINTS = [
  ["Your environment", "We build the eval environment from your APIs, data and policies."],
  ["Domain-expert reviewers", "People who know your field review what your agent does."],
  ["Volume pricing", "Pricing that fits how many trials you actually run."],
  ["Security review", "Coming soon."],
] as const;

export default function ContactSalesPage() {
  return (
    <>
      <PageShell>
        <div className="grid gap-12 lg:grid-cols-12">
          <header className="lg:col-span-5">
            <Eyebrow>Enterprise</Eyebrow>
            <h1 className="t-h1 mt-6 text-balance">Talk to us</h1>
            <p className="t-lead mt-4 max-w-[48ch]">Tell us about your agent. A real person will reply within one business day.</p>
            <ul className="mt-10 flex flex-col divide-y divide-line-2 border-y border-line-2">
              {POINTS.map(([h, b]) => (
                <li key={h} className="py-4">
                  <div className="text-[15px] text-fg">{h}</div>
                  <div className="mt-1 text-[14px] text-muted">{b}</div>
                </li>
              ))}
            </ul>
          </header>
          <section aria-label="Contact form" className="lg:col-span-7">
            <ContactSalesForm />
          </section>
        </div>
      </PageShell>
      <Footer />
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { Eyebrow, PageShell } from "@/components/ui";
import { Footer } from "@/components/marketing/Footer";
import { FeedbackForm } from "./FeedbackForm";

export const metadata: Metadata = {
  title: "Feedback · Standard Evals",
  description: "Two minutes of honest feedback on Standard Evals, an agent-evaluation tool built at a hackathon by a team of AI agents.",
  robots: { index: false },
};

type Props = { searchParams: Promise<{ ref?: string | string[] }> };

export default async function FeedbackPage({ searchParams }: Props) {
  const raw = (await searchParams).ref;
  const ref = (Array.isArray(raw) ? raw[0] : raw)?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128) || null;
  return (
    <>
      <PageShell>
        <div className="grid gap-12 lg:grid-cols-12">
          <header className="lg:col-span-5">
            <Eyebrow>Feedback</Eyebrow>
            <h1 className="t-h1 mt-6 text-balance">Would you actually use this?</h1>
            <p className="t-lead mt-4 max-w-[48ch]">
              Standard Evals was built on Nov 8 at a hackathon by a team of AI agents. It tests AI agents against a simulated
              customer in a sandbox and grades what they actually did. We want blunt answers, including “no”.
            </p>
            <p className="t-body mt-6 text-muted">
              Haven&apos;t looked yet? <Link className="underline underline-offset-4 hover:text-fg" href="/demo">Watch the demo replay</Link>.
            </p>
            <p className="t-body mt-3 text-muted">Only the quote box can ever be shown publicly, and only if you tick the consent box.</p>
          </header>
          <section aria-label="Feedback form" className="lg:col-span-7">
            <FeedbackForm refToken={ref} />
          </section>
        </div>
      </PageShell>
      <Footer />
    </>
  );
}

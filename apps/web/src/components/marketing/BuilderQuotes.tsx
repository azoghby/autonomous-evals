import { listPublicQuotes } from "@/server/feedback";
import { attribution, type PublicQuote } from "@/server/feedback-logic";
import { Eyebrow, Reveal, Section } from "../ui";

type Props = { quotes: PublicQuote[] };

/** Presentational: renders nothing when there are no real, consented quotes. Never fed placeholder copy. */
export function BuilderQuotesView({ quotes }: Props) {
  if (quotes.length === 0) return null;
  return (
    <Section id="builders" labelledBy="builders-h" className="scroll-mt-16">
      <Reveal className="mb-10 flex flex-col gap-4">
        <Eyebrow>Feedback</Eyebrow>
        <h2 id="builders-h" className="t-h2 text-balance text-fg">What builders say</h2>
        <p className="t-lead max-w-[36rem]">Unedited answers from agent builders we asked, shown with their permission.</p>
      </Reveal>
      <ul className="grid gap-px overflow-hidden rounded-[4px] border border-line-2 bg-line-2 md:grid-cols-2">
        {quotes.map((q) => (
          <li key={q.id} className="bg-bg p-6 sm:p-8">
            <figure className="flex h-full flex-col justify-between gap-6">
              <blockquote className="text-[17px] leading-relaxed text-fg">&ldquo;{q.quote}&rdquo;</blockquote>
              <figcaption className="text-[13px] text-muted">{attribution(q)}</figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Homepage section. A DB error hides the section rather than breaking the page. */
export async function BuilderQuotes() {
  let quotes: PublicQuote[] = [];
  try { quotes = await listPublicQuotes(); } catch (err) { console.error("builder quotes failed", err instanceof Error ? err.message : err); }
  return <BuilderQuotesView quotes={quotes} />;
}

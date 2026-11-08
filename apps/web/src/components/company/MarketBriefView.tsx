"use client";
import { MarketBriefSchema } from "@ae/core/company/research";
import { Mono } from "@/components/app/ui";

/** Only http(s) links are rendered as anchors (model output is untrusted). */
export function SafeLink({ url, label }: { url: string; label?: string }) {
  if (!/^https?:\/\//i.test(url)) return <span className="break-all text-muted">{label ?? url}</span>;
  return <a href={url} target="_blank" rel="noopener noreferrer" className="break-all text-accent-text underline-offset-4 hover:underline">{label ?? url.replace(/^https?:\/\//i, "").slice(0, 60)}</a>;
}

const H = ({ children }: { children: string }) => <h4 className="mb-2 font-mono text-[11px] uppercase text-subtle">{children}</h4>;

/** Renders a stored market brief; falls back to raw JSON if it does not match the schema. */
export function MarketBriefView({ brief, date }: { brief: unknown; date: string }) {
  const parsed = MarketBriefSchema.safeParse(brief);
  if (!parsed.success) return <Mono>{JSON.stringify(brief, null, 2)}</Mono>;
  const b = parsed.data;
  return (
    <div className="space-y-6">
      <div>
        <p className="font-mono text-[11px] uppercase text-subtle">{date}</p>
        <p className="mt-1 text-lg text-fg">{b.headline}</p>
      </div>
      <div><H>Segments</H>
        <ul className="space-y-4">
          {b.segments.map((s) => (
            <li key={s.segment} className="rounded-[4px] border border-line-2 p-4">
              <p className="text-fg">{s.segment}</p>
              <p className="mt-1 text-sm text-muted">{s.summary}</p>
              {s.notableCompanies.length > 0 && (
                <ul className="mt-3 space-y-1 text-sm">
                  {s.notableCompanies.map((c) => (
                    <li key={c.name} className="text-fg-2">{c.name}: <span className="text-muted">{c.what}</span> {c.sourceUrls.map((u, i) => <span key={u} className="mr-2"><SafeLink url={u} label={`[${i + 1}]`} /></span>)}</li>
                  ))}
                </ul>
              )}
              {s.signals.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">{s.signals.map((x) => <li key={x}>{x}</li>)}</ul>}
            </li>
          ))}
        </ul>
      </div>
      <div><H>Competitors</H>
        <ul className="space-y-3 text-sm">
          {b.competitors.map((c) => (
            <li key={c.name}><span className="text-fg">{c.name}</span> <span className="text-muted">{c.positioning}</span>
              {c.pricing && <span className="text-fg-2"> Pricing: {c.pricing}.</span>}
              {c.sourceUrls.map((u, i) => <span key={u} className="ml-2"><SafeLink url={u} label={`[${i + 1}]`} /></span>)}
            </li>
          ))}
        </ul>
      </div>
      <div><H>Pricing benchmarks</H>
        <ul className="space-y-1 text-sm">
          {b.pricingBenchmarks.map((p) => <li key={`${p.item}${p.sourceUrl}`} className="text-fg-2">{p.item}: <span className="font-mono">{p.value}</span> <SafeLink url={p.sourceUrl} label="[source]" /></li>)}
        </ul>
      </div>
      <div><H>Opportunities</H>
        <ul className="space-y-2 text-sm">
          {b.opportunities.map((o) => <li key={o.title}><span className="text-fg">{o.title}</span> <span className="text-muted">{o.rationale}</span></li>)}
        </ul>
      </div>
    </div>
  );
}

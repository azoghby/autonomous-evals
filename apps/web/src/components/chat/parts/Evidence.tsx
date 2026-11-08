"use client";
import { useId, useState } from "react";
import type { EvidenceItem } from "../nova-types";

/** Inline citation chips; each opens the transcript excerpt and the failed check it came from. */
export function EvidenceChips({ ids, evidence, label }: { ids: string[]; evidence: EvidenceItem[]; label?: string }) {
  const base = useId();
  const [open, setOpen] = useState<string | null>(null);
  const items = ids.map((id) => ({ id, n: evidence.findIndex((e) => e.id === id) })).filter((x) => x.n >= 0);
  if (items.length === 0) return null;
  const current = evidence.find((e) => e.id === open);
  return (
    <div>
      <span className="nv-cites" role="group" aria-label={label ?? "Evidence"}>
        {items.map(({ id, n }) => (
          <button
            key={id} type="button" className="nv-cite" aria-expanded={open === id} aria-controls={`${base}-panel`}
            onClick={() => setOpen((o) => (o === id ? null : id))}
          >
            E{n + 1}<span className="sr-only">: {evidence[n]!.scenarioTitle}, trial {evidence[n]!.trial}</span>
          </button>
        ))}
      </span>
      <div id={`${base}-panel`} aria-live="polite">
        {current && <EvidenceCard item={current} n={evidence.indexOf(current) + 1} />}
      </div>
    </div>
  );
}

export function EvidenceCard({ item, n }: { item: EvidenceItem; n: number }) {
  return (
    <figure className="nv-evidence nv-enter">
      <figcaption className="nv-evidence-meta"><span>E{n}</span><span>{item.scenarioTitle}</span><span>trial {item.trial}</span></figcaption>
      <p className="nv-evidence-check">{item.check}</p>
      {item.excerpt && <blockquote><span className="sr-only">{item.role === "assistant" ? "Your agent said: " : "Transcript: "}</span>{item.excerpt}</blockquote>}
    </figure>
  );
}

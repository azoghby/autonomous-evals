import type { ReactNode } from "react";
import { cn } from "./cn";
import { Eyebrow } from "./Eyebrow";

/**
 * Neon-style section header. >=1024: 12-col grid, left rail (cols 1-4: Eyebrow + faint mono numeral), right (cols 5-12: two-tone h2 + lead).
 * Pass title as e.g. <>White lead. <span className="text-muted">Gray continuation</span></>.
 */
export function SectionHeader({
  index, eyebrow, title, lead, id, className,
}: { index?: string; eyebrow: string; title: ReactNode; lead?: ReactNode; id?: string; className?: string }) {
  return (
    <header className={cn("grid gap-6 lg:grid-cols-12 lg:gap-8", className)}>
      <div className="flex flex-col gap-6 lg:col-span-4">
        <Eyebrow>{eyebrow}</Eyebrow>
        {index && <span aria-hidden className="t-numeral select-none">{index}</span>}
      </div>
      <div className="flex flex-col gap-5 lg:col-span-8">
        <h2 id={id} className="t-h2 max-w-[22ch] text-fg text-balance sm:max-w-[26ch]">{title}</h2>
        {lead && <p className="t-lead max-w-[60ch]">{lead}</p>}
      </div>
    </header>
  );
}

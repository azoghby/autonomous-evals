import type { ReactNode } from "react";
import { cn, Eyebrow } from "@/components/ui";

/** Page header: mono eyebrow, 400-weight h1, one-line lead, then an inline meta row (chips live here, not at the far right). */
export function PageHead({ eyebrow, title, lead, meta, actions, className }: {
  eyebrow: ReactNode; title: ReactNode; lead?: ReactNode; meta?: ReactNode; actions?: ReactNode; className?: string;
}) {
  return (
    <header className={cn("mb-10 flex flex-wrap items-end justify-between gap-x-8 gap-y-6 border-b border-line pb-8 sm:mb-12", className)}>
      <div className="min-w-0 max-w-[720px]">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="t-h1 mt-4 text-fg">{title}</h1>
        {lead && <p className="t-lead mt-3 max-w-[60ch]">{lead}</p>}
        {meta && <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-muted">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-3">{actions}</div>}
    </header>
  );
}

/** Thin mid-dot separator for meta rows. */
export function MetaDot() {
  return <span aria-hidden className="hidden text-faint sm:inline">·</span>;
}

/** Hairline panel with an optional mono header strip. */
export function Panel({ title, aside, children, className, bodyClassName }: {
  title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string;
}) {
  return (
    <section className={cn("rounded-[4px] border border-line-2 bg-bg-raised", className)}>
      {(title || aside) && (
        <header className="flex min-h-11 items-center justify-between gap-4 border-b border-line px-5 py-2.5">
          {title && <h2 className="t-eyebrow text-subtle">{title}</h2>}
          {aside}
        </header>
      )}
      <div className={cn("p-5 sm:p-6", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Mono section label used above lists (findings, fixes). */
export function SectionLabel({ id, children, aside }: { id?: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-4 flex items-baseline justify-between gap-4">
      <h2 id={id} className="t-eyebrow text-subtle">{children}</h2>
      {aside}
    </div>
  );
}

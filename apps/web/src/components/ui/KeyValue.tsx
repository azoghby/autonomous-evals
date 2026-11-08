import type { ReactNode } from "react";
import { cn } from "./cn";

/** Hairline-separated label/value row (mono label left, value right). Wrap rows in a <dl>. */
export function KeyValue({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 border-b border-line py-3 last:border-b-0", className)}>
      <dt className="font-mono text-[11px] uppercase text-subtle">{label}</dt>
      <dd className="min-w-0 text-right text-[13px] text-fg-2">{children}</dd>
    </div>
  );
}

import type { ReactNode } from "react";
import { cn } from "./cn";

/** Mono label + large (weight 400) value + optional hint. */
export function Stat({ label, value, hint, className }: { label: string; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <span className="font-mono text-[11px] uppercase text-subtle">{label}</span>
      <span className="font-mono text-[32px] leading-none tracking-[-0.04em] text-fg tabular-nums md:text-[44px]">{value}</span>
      {hint && <span className="text-[13px] text-muted">{hint}</span>}
    </div>
  );
}

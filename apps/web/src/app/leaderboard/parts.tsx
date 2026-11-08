import type { ReactNode } from "react";
import { cn } from "@/components/ui";
import { percent } from "@/server/leaderboard";

const TONE_BAR = { ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", accent: "bg-accent" } as const;

/** Pass-rate tone: green from 85%, amber from 60%, red below. Colour never carries meaning alone: the number is always printed. */
export const rateTone = (r: number): keyof typeof TONE_BAR => (r >= 0.85 ? "ok" : r >= 0.6 ? "warn" : "danger");

export function RateBar({ value, label, tone, className }: { value: number; label?: string; tone?: keyof typeof TONE_BAR; className?: string }) {
  const t = tone ?? rateTone(value);
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div role="img" aria-label={`${label ?? "Pass rate"} ${percent(value)}`} className="relative h-1.5 w-full min-w-16 overflow-hidden rounded-[2px] bg-line-2">
        <span className={cn("absolute inset-y-0 left-0 block", TONE_BAR[t])} style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
      <span className="t-data w-10 shrink-0 text-right text-fg">{percent(value)}</span>
    </div>
  );
}

export const SEVERITY_TEXT: Record<string, string> = { critical: "text-danger", high: "text-warn", medium: "text-fg-2", low: "text-subtle" };

export function SeverityDot({ severity }: { severity: string }) {
  const color = severity === "critical" ? "bg-danger" : severity === "high" ? "bg-warn" : severity === "medium" ? "bg-fg-2" : "bg-subtle";
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", color)} />;
}

export function KindTag({ kind }: { kind: string }) {
  const ref = kind === "reference";
  return (
    <span className={cn("inline-block rounded-[2px] border px-1.5 py-[3px] font-mono text-[11px] uppercase leading-none", ref ? "border-line-3 text-fg-2" : "border-accent/60 text-accent-text")}>
      {ref ? "Reference baseline" : "Third-party"}
    </span>
  );
}

export const fmtDate = (d: Date): string => d.toISOString().slice(0, 10);

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th scope="col" className={cn("px-4 py-3 text-left font-mono text-[11px] font-normal uppercase text-subtle", className)}>{children}</th>;
}

export const LEADERBOARD_NAV = [
  { label: "How it works", href: "/#how" },
  { label: "Sample report", href: "/sample" },
  { label: "Leaderboard", href: "/leaderboard" },
  { label: "Pricing", href: "/#pricing" },
];

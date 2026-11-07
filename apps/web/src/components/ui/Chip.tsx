import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type ChipTone = "neutral" | "coral" | "ok" | "warn" | "info" | "danger";

const tones: Record<ChipTone, string> = {
  neutral: "bg-glass text-cream/80 border-glass-border",
  coral: "bg-coral/15 text-coral border-coral/40",
  ok: "bg-ok/15 text-ok border-ok/35",
  warn: "bg-warn/15 text-warn border-warn/35",
  info: "bg-[#8fa8ff]/15 text-[#a9bcff] border-[#8fa8ff]/35",
  danger: "bg-danger/15 text-[#ff8e81] border-danger/40",
};

export type ChipProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: ChipTone;
  /** Show a leading dot. */
  dot?: boolean;
  /** Pulse the dot (for in-progress states). */
  pulse?: boolean;
};

export function Chip({ tone = "neutral", dot, pulse, className, children, ...rest }: ChipProps) {
  return (
    <span
      {...rest}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium leading-none",
        tones[tone],
        className,
      )}
    >
      {dot && (
        <span
          aria-hidden
          className={cn("size-1.5 rounded-full bg-current", pulse && "motion-safe:animate-pulse")}
        />
      )}
      {children}
    </span>
  );
}

export type JobStatus =
  | "draft" | "needs_clarification" | "quoted" | "awaiting_payment" | "planning"
  | "running" | "investigating" | "delivered" | "payment_review" | "paused_budget"
  | "failed" | "cancelled";
export type FindingStatus = "confirmed" | "rubric_concern" | "inconclusive";
export type AnyStatus = JobStatus | FindingStatus;

const STATUS: Record<AnyStatus, { label: string; tone: ChipTone; pulse?: boolean }> = {
  draft: { label: "Draft", tone: "neutral" },
  needs_clarification: { label: "Needs clarification", tone: "warn" },
  quoted: { label: "Quoted", tone: "info" },
  awaiting_payment: { label: "Awaiting payment", tone: "coral" },
  planning: { label: "Planning", tone: "info", pulse: true },
  running: { label: "Running", tone: "info", pulse: true },
  investigating: { label: "Investigating", tone: "info", pulse: true },
  delivered: { label: "Delivered", tone: "ok" },
  payment_review: { label: "Payment review", tone: "warn" },
  paused_budget: { label: "Paused (budget)", tone: "warn" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  confirmed: { label: "Confirmed", tone: "ok" },
  rubric_concern: { label: "Rubric concern", tone: "warn" },
  inconclusive: { label: "Inconclusive", tone: "neutral" },
};

export function StatusChip({
  status,
  className,
}: {
  status: AnyStatus | (string & {});
  className?: string;
}) {
  const known = STATUS[status as AnyStatus];
  const def = known ?? { label: status.replace(/_/g, " "), tone: "neutral" as ChipTone };
  return (
    <Chip tone={def.tone} dot pulse={"pulse" in def ? def.pulse : false} className={className}>
      {def.label}
    </Chip>
  );
}

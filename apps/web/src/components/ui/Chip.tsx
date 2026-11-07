import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type ChipTone = "neutral" | "muted" | "coral" | "ok" | "warn" | "info" | "danger";
/** "soft" = small filled pill (default for <Chip>); "plain" = dot + text, no fill/border (default for <StatusChip>). */
export type ChipVariant = "soft" | "plain";

const soft: Record<ChipTone, string> = {
  neutral: "bg-glass text-cream/75",
  muted: "bg-glass text-cream/55",
  coral: "bg-coral/12 text-coral",
  ok: "bg-ok/12 text-ok",
  warn: "bg-warn/12 text-warn",
  info: "bg-[#8fa8ff]/12 text-[#a9bcff]",
  danger: "bg-danger/12 text-[#ff8e81]",
};
const plain: Record<ChipTone, string> = {
  neutral: "text-cream/70",
  muted: "text-cream/50",
  coral: "text-coral",
  ok: "text-ok",
  warn: "text-warn",
  info: "text-[#a9bcff]",
  danger: "text-[#ff8e81]",
};

export type ChipProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: ChipTone;
  variant?: ChipVariant;
  /** Show a leading dot. */
  dot?: boolean;
  /** Pulse the dot (for in-progress states). */
  pulse?: boolean;
};

export function Chip({ tone = "neutral", variant = "soft", dot, pulse, className, children, ...rest }: ChipProps) {
  return (
    <span
      {...rest}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium leading-none",
        variant === "soft" ? cn("rounded-full px-2.5 py-1", soft[tone]) : plain[tone],
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

// Colour budget: only attention states get a hue. Progress/neutral states stay cream.
const STATUS: Record<AnyStatus, { label: string; tone: ChipTone; pulse?: boolean }> = {
  draft: { label: "Draft", tone: "muted" },
  needs_clarification: { label: "Needs clarification", tone: "warn" },
  quoted: { label: "Quoted", tone: "neutral" },
  awaiting_payment: { label: "Awaiting payment", tone: "coral" },
  planning: { label: "Planning", tone: "neutral", pulse: true },
  running: { label: "Running", tone: "neutral", pulse: true },
  investigating: { label: "Investigating", tone: "neutral", pulse: true },
  delivered: { label: "Delivered", tone: "ok" },
  payment_review: { label: "Payment review", tone: "warn" },
  paused_budget: { label: "Paused (budget)", tone: "warn" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "muted" },
  confirmed: { label: "Confirmed", tone: "ok" },
  rubric_concern: { label: "Rubric concern", tone: "warn" },
  inconclusive: { label: "Inconclusive", tone: "muted" },
};

export function StatusChip({
  status,
  className,
  variant = "plain",
}: {
  status: AnyStatus | (string & {});
  className?: string;
  /** "plain" (default): dot + text. "soft": filled pill. */
  variant?: ChipVariant;
}) {
  const known = STATUS[status as AnyStatus];
  const def = known ?? { label: status.replace(/_/g, " "), tone: "muted" as ChipTone };
  return (
    <Chip tone={def.tone} variant={variant} dot pulse={"pulse" in def ? def.pulse : false} className={className}>
      {def.label}
    </Chip>
  );
}

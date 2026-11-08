import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type ChipTone = "neutral" | "muted" | "accent" | "ok" | "warn" | "info" | "danger";
/** "soft" = mono uppercase bordered tag (default for <Chip>); "plain" = dot + text, no fill/border (default for <StatusChip>). */
export type ChipVariant = "soft" | "plain";

// "soft" = 2px-radius mono 11px uppercase tag with a 1px tone border (no fill).
const soft: Record<ChipTone, string> = {
  neutral: "border-line-3 text-fg-2",
  muted: "border-line-2 text-muted",
  accent: "border-accent/60 text-accent-text",
  ok: "border-ok/40 text-ok",
  warn: "border-warn/40 text-warn",
  info: "border-accent/60 text-accent-text",
  danger: "border-danger/40 text-danger",
};
const plain: Record<ChipTone, string> = {
  neutral: "text-fg-2",
  muted: "text-muted",
  accent: "text-accent-text",
  ok: "text-ok",
  warn: "text-warn",
  info: "text-accent-text",
  danger: "text-danger",
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
        "inline-flex items-center gap-1.5 leading-none",
        variant === "soft" ? cn("rounded-[2px] border px-1.5 py-1 font-mono text-[11px] uppercase", soft[tone]) : cn("text-[13px]", plain[tone]),
        className,
      )}
    >
      {dot && (
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full bg-current", pulse && "motion-safe:animate-pulse")}
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

// Colour budget: only attention states get a hue. Progress/neutral states stay white.
const STATUS: Record<AnyStatus, { label: string; tone: ChipTone; pulse?: boolean }> = {
  draft: { label: "Draft", tone: "muted" },
  needs_clarification: { label: "Needs clarification", tone: "warn" },
  quoted: { label: "Quoted", tone: "neutral" },
  awaiting_payment: { label: "Awaiting payment", tone: "accent" },
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
  /** "plain" (default): dot + text. "soft": bordered mono tag. */
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

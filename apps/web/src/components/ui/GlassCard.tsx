import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type GlassCardProps = HTMLAttributes<HTMLDivElement> & {
  /** Slightly heavier fill for nested/foreground cards. */
  strong?: boolean;
};

/** Quiet frosted surface for navy backgrounds: hairline border, soft fill, no heavy shadow. */
export function GlassCard({ strong, className, ...rest }: GlassCardProps) {
  return (
    <div
      {...rest}
      className={cn(
        "rounded-[var(--radius-card)] border border-cream/10 backdrop-blur-lg",
        strong ? "bg-cream/[0.07]" : "bg-cream/[0.04]",
        className,
      )}
    />
  );
}

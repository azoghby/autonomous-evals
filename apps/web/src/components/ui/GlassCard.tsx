import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type GlassCardProps = HTMLAttributes<HTMLDivElement> & {
  /** Stronger fill for nested/foreground cards. */
  strong?: boolean;
};

/** Translucent frosted card for navy backgrounds. */
export function GlassCard({ strong, className, ...rest }: GlassCardProps) {
  return (
    <div
      {...rest}
      className={cn(
        "rounded-[var(--radius-card)] border border-glass-border backdrop-blur-xl shadow-[0_20px_50px_-20px_rgb(0_0_0/0.55),inset_0_1px_0_rgb(255_255_255/0.1)]",
        strong ? "bg-glass-strong" : "bg-glass",
        className,
      )}
    />
  );
}

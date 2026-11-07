import { ArrowUpRight } from "lucide-react";
import { cn } from "./cn";

/** ↗ arrow that nudges up-right when its closest `.group` (Button, or any `group` link) is hovered. */
export function NudgeArrow({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <ArrowUpRight
      size={size}
      aria-hidden
      className={cn("transition-transform duration-300 ease-[var(--ease-out-expo)] group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transform-none", className)}
    />
  );
}

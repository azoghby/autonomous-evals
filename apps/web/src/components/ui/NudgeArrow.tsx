import { ArrowUpRight } from "lucide-react";
import { cn } from "./cn";

/** ↗ arrow that nudges up-right when its closest `.group` (Button, or any `group` link) is hovered. */
export function NudgeArrow({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <ArrowUpRight
      size={size}
      aria-hidden
      className={cn("transition-transform duration-150 ease-[var(--ease-hover)] group-hover:-translate-y-[2px] group-hover:translate-x-[2px] motion-reduce:transform-none", className)}
    />
  );
}

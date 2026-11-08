import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type SurfaceProps = HTMLAttributes<HTMLDivElement> & {
  /** Slightly raised fill for nested/foreground surfaces. */
  strong?: boolean;
};

/** Flat panel: 1px line-2, bg-raised, 4px radius, no shadow. */
export function Surface({ strong, className, ...rest }: SurfaceProps) {
  return (
    <div
      {...rest}
      className={cn("rounded-[4px] border border-line-2", strong ? "bg-bg-hover" : "bg-bg-raised", className)}
    />
  );
}

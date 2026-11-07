import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type SurfaceProps = HTMLAttributes<HTMLDivElement> & {
  /** Slightly raised fill for nested/foreground surfaces. */
  strong?: boolean;
};

/** Flat hairline surface on black: 1px border, tiny radius, no blur, no shadow. */
export function Surface({ strong, className, ...rest }: SurfaceProps) {
  return (
    <div
      {...rest}
      className={cn("rounded-lg border border-line", strong ? "bg-white/[0.04]" : "bg-white/[0.015]", className)}
    />
  );
}

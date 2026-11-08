import type { ElementType, HTMLAttributes } from "react";
import { cn } from "./cn";

/** Hairline panel with 8px L-shaped corner ticks. With `interactive`, ticks turn accent on hover / focus-within. */
export function Frame({
  className, ticks = true, interactive, as, children, ...rest
}: HTMLAttributes<HTMLElement> & { ticks?: boolean; interactive?: boolean; as?: ElementType }) {
  const Tag = (as ?? "div") as ElementType;
  return (
    <Tag {...rest} data-interactive={interactive ? "true" : undefined} className={cn("frame", className)}>
      {ticks && (["tl", "tr", "bl", "br"] as const).map((c) => <span key={c} aria-hidden data-c={c} className="frame-tick" />)}
      {children}
    </Tag>
  );
}

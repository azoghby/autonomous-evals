import type { ElementType, HTMLAttributes } from "react";
import { cn } from "./cn";

/** Shared page container (max 1440px, 20/32px gutters). Every left edge in the app should come from this. */
export function Container({ as, className, ...rest }: HTMLAttributes<HTMLElement> & { as?: ElementType }) {
  const Tag = (as ?? "div") as ElementType;
  return <Tag {...rest} className={cn("container-x", className)} />;
}

import type { ReactNode } from "react";
import { cn } from "./cn";
import { Container } from "./Container";

/** Page section: 128px (80px mobile) vertical padding, optional `band` (bg-band + top hairline), inner Container. */
export function Section({
  id, band, labelledBy, className, children,
}: { id?: string; band?: boolean; labelledBy?: string; className?: string; children?: ReactNode }) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn("py-20 md:py-32", band ? "border-t border-line-2 bg-bg-band" : "bg-bg", className)}
    >
      <Container>{children}</Container>
    </section>
  );
}

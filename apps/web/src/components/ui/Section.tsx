import type { ReactNode } from "react";
import { cn } from "./cn";
import { Container } from "./Container";

/** "grid" = dot grid; "glow" = grid + blue glow; "full" = grid + glow + film grain. */
export type SectionAtmosphere = "none" | "grid" | "glow" | "full";

/**
 * Page section: 128px (80px mobile) vertical padding, optional `band` (bg-band + top hairline with rail node + dot grid), inner Container.
 * `atmosphere` overrides the default (band => "grid", otherwise "none"), so app pages are unaffected.
 */
export function Section({
  id, band, labelledBy, className, children, atmosphere,
}: { id?: string; band?: boolean; labelledBy?: string; className?: string; children?: ReactNode; atmosphere?: SectionAtmosphere }) {
  const mode = atmosphere ?? (band ? "grid" : "none");
  const decorated = mode !== "none" || band;
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn("py-20 md:py-32", decorated && "relative isolate", band ? "border-t border-line-2 bg-bg-band" : "bg-bg", className)}
    >
      {decorated && (
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          {mode !== "none" && <div className="dot-grid" />}
          {(mode === "glow" || mode === "full") && <div className="blue-glow" />}
          {mode === "full" && <div className="grain" />}
          {band && <div className="sec-divider" />}
        </div>
      )}
      <Container>{children}</Container>
    </section>
  );
}

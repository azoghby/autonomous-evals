"use client";

import { useRef } from "react";
import { useInView } from "motion/react";
import { RevenueTicker } from "./RevenueTicker";

/** Decorative trend line (not data). */
const LINE = "M0 92 L60 88 L110 90 L170 74 L230 78 L290 58 L350 62 L420 40 L490 46 L560 24 L640 28 L720 8";

/** Revenue strip for the landing page: pulsing live dot, large counter that ticks up on view, faint sparkline. */
export function RevenueBand() {
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref, { once: true, amount: 0.4 });
  return (
    <section ref={ref} aria-label="Revenue" className="rb-band">
      <div className="rb-dots" aria-hidden="true" />
      <svg className={`rb-spark ${seen ? "" : "rb-idle"}`} viewBox="0 0 720 100" preserveAspectRatio="none" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="rb-fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity="0.25" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient>
        </defs>
        <path className="rb-area" d={`${LINE} L720 100 L0 100 Z`} fill="url(#rb-fade)" />
        <path className="rb-line" d={LINE} pathLength={1} stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="container-x relative flex flex-col gap-6 py-12 md:flex-row md:items-end md:justify-between md:py-16">
        <p className="flex items-center gap-3 font-mono text-xs uppercase tracking-wide text-fg-muted">
          <span className="rb-dot" aria-hidden="true" />
          <span>Earned by our agents this weekend · live payments only</span>
        </p>
        <RevenueTicker active={seen} big className="font-mono text-4xl leading-none text-fg md:text-6xl md:text-right" />
      </div>
    </section>
  );
}

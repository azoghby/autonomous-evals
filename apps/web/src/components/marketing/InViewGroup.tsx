"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Tiny scroll-trigger island. SSR renders content fully visible; after mount, if the group is below the fold it is
 * "armed" (CSS may collapse children) and flips to data-inview="true" once intersecting. Pair with CSS attribute selectors.
 */
export function InViewGroup({ children, className, threshold = 0.25 }: { children: ReactNode; className?: string; threshold?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.85 && r.bottom > 0) { el.dataset.inview = "true"; return; }
    el.dataset.armed = "true";
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) { el.dataset.inview = "true"; io.disconnect(); }
    }, { threshold });
    io.observe(el);
    return () => io.disconnect();
  }, [threshold]);
  return <div ref={ref} className={className}>{children}</div>;
}

"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

export type InViewState = "armed" | "in" | undefined;

/** Wrapper that flips data-st to "in" once scrolled into view (IntersectionObserver). SSR / no-JS / reduced-motion: no
 *  data-st at all, so content is simply visible. CSS in report.module.css keys off [data-st]. */
export function InView({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [st, setSt] = useState<InViewState>(undefined);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    setSt("armed");
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setSt("in"); io.disconnect(); }
    }, { threshold: 0.2, rootMargin: "0px 0px -40px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} data-st={st} className={className}>{children}</div>;
}

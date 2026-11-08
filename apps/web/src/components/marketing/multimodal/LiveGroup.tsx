"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * In-view island for the multimodal section. SSR renders everything visible and static.
 * After mount: below-the-fold groups get data-armed (CSS may hide the reveal bits), data-inview flips true once
 * intersecting, and data-live tracks current visibility so the looping waveform pauses off-screen.
 */
export function LiveGroup({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!(r.top < window.innerHeight * 0.85 && r.bottom > 0)) el.dataset.armed = "true";
    const io = new IntersectionObserver(([e]) => {
      if (!e) return;
      el.dataset.live = e.isIntersecting ? "true" : "false";
      if (e.isIntersecting && e.intersectionRatio >= 0.2) el.dataset.inview = "true";
    }, { threshold: [0, 0.2] });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} className={className}>{children}</div>;
}

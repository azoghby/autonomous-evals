"use client";
import { animate } from "animejs";
import { useEffect, useRef } from "react";
import { cn } from "./cn";

/** [selector, dx%, dy%, scale, ms] — slow alternating drift/breathe per blob (anime.js, transform only). */
const DRIFT = [
  [".glow-coral", 14, -10, 1.12, 22000],
  [".glow-indigo", -12, 14, 0.92, 28000],
  [".glow-amber", -18, -14, 1.25, 18000],
] as const;

/** Decorative blurred coral/indigo glow + fluted-glass ribs + grain. Blobs drift via anime.js; static under reduced motion. */
export function RibbedGlow({ dim, className }: { dim?: boolean; className?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const anims = DRIFT.map(([sel, x, y, s, ms]) =>
      animate(el.querySelector(sel) as HTMLElement, {
        translateX: `${x}%`, translateY: `${y}%`, scale: s,
        duration: ms, ease: "inOutSine", loop: true, alternate: true,
      }),
    );
    return () => anims.forEach((a) => a.revert());
  }, []);
  return (
    <div ref={root} aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", dim && "opacity-45", className)}>
      <div className="glow-field">
        <span className="glow-blob glow-coral" />
        <span className="glow-blob glow-indigo" />
        <span className="glow-blob glow-amber" />
      </div>
      <div className="ribs" />
      <div className="grain" />
    </div>
  );
}

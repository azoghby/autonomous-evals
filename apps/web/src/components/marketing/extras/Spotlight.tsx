"use client";
import type { PointerEvent, ReactNode } from "react";

/** Cursor-tracking spotlight: writes --mx/--my on pointer move; CSS translates a fixed glow (transform + opacity only). */
export function Spotlight({ children, className = "" }: { children: ReactNode; className?: string }) {
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <div onPointerMove={onMove} className={`pr-spot ${className}`}>
      <span aria-hidden className="pr-glow" />
      {children}
    </div>
  );
}

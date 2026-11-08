"use client";
import { useEffect, useState, type RefObject } from "react";

/**
 * Decides, once after hydration, whether an element must wait for scroll before revealing.
 * Returns "pending" on SSR / first render (content visible, no hidden state => never invisible without JS),
 * then "hidden" if the element is below the fold at mount, or "visible" if already in view (no animation).
 */
export type RevealPhase = "pending" | "hidden" | "visible";

export function useRevealPhase(ref: RefObject<HTMLElement | null>): RevealPhase {
  const [phase, setPhase] = useState<RevealPhase>("pending");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPhase(r.top < window.innerHeight && r.bottom > 0 ? "visible" : "hidden");
  }, [ref]);
  return phase;
}

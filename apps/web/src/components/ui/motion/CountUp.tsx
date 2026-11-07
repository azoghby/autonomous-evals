"use client";
import { animate } from "animejs";
import { useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";

export type CountUpProps = {
  value: number;
  prefix?: string;
  suffix?: string;
  /** Milliseconds. Default 1100. */
  duration?: number;
  className?: string;
};

/** anime.js number count-up, triggered once on scroll into view. SSR + reduced motion render the final value. */
export function CountUp({ value, prefix = "", suffix = "", duration = 1100, className }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const [text, setText] = useState(String(value));
  const armed = useRef(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!inView) {
      if (!armed.current) { armed.current = true; setText("0"); }
      return;
    }
    const state = { v: 0 };
    const anim = animate(state, {
      v: value,
      duration,
      ease: "outExpo",
      onUpdate: () => setText(String(Math.round(state.v))),
      onComplete: () => setText(String(value)),
    });
    return () => { anim.revert(); };
  }, [inView, value, duration]);

  return <span ref={ref} className={className}>{prefix}{text}{suffix}</span>;
}

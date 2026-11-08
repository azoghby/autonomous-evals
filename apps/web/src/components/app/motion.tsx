"use client";
// Local motion helpers for the app screens (compositor-only: opacity + transform). Reduced motion is honoured
// through <MotionConfig reducedMotion="user"> in app/(app)/template.tsx and the checks below for anime.js.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion, type Variants } from "motion/react";
import { animate } from "animejs";

export const EASE = [0.16, 1, 0.3, 1] as const;
// Critically damped (damping = 2*sqrt(stiffness*mass)): settles without overshoot.
export const SPRING = { type: "spring", stiffness: 400, damping: 40, mass: 1 } as const;
export const SOFT = { duration: 0.24, ease: EASE } as const;
export const STAGGER = 0.05;

const rise: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: SOFT },
};

/** Staggered list container; children use <StaggerItem>. */
export function Stagger({ children, className, as = "div", delay = 0 }: { children: ReactNode; className?: string; as?: "div" | "ul" | "ol"; delay?: number }) {
  const C = motion[as];
  return (
    <C className={className} initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: STAGGER, delayChildren: delay } } }}>
      {children}
    </C>
  );
}

export function StaggerItem({ children, className, as = "div" }: { children: ReactNode; className?: string; as?: "div" | "li" | "section" | "tr" }) {
  const C = motion[as] as typeof motion.div;
  return <C className={className} variants={rise}>{children}</C>;
}

/** Single fade-and-rise on mount. */
export function Reveal({ children, className, delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div className={className} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SOFT, delay }}>
      {children}
    </motion.div>
  );
}

/** anime.js number count-up; renders the final value immediately under reduced motion. */
export function CountUp({ value, format, className, duration = 900 }: { value: number; format: (n: number) => string; className?: string; duration?: number }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState(() => format(value));
  useEffect(() => {
    if (reduce) { setText(format(value)); return; }
    const state = { n: 0 };
    const anim = animate(state, { n: value, duration, ease: "outExpo", onUpdate: () => setText(format(state.n)) });
    return () => { anim.pause(); };
  }, [value, reduce, duration]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span ref={ref} className={className}>{text}</span>;
}

"use client";
import { m, type Variants } from "motion/react";
import { useRef, type ReactNode } from "react";
import { motionTokens } from "./tokens";
import { useMotionDuration } from "./useMotionOk";
import { useRevealPhase } from "./useInitialInView";

export type StaggerProps = {
  children?: ReactNode;
  className?: string;
  as?: "div" | "ul" | "ol" | "section";
  /** Seconds between children. Default motionTokens.stagger (0.05). */
  gap?: number;
  /** Seconds before the first child. */
  delay?: number;
  /** Animate on scroll into view (default true) or immediately on mount (false). */
  inView?: boolean;
  margin?: string;
  id?: string;
};

const parts = { div: m.div, ul: m.ul, ol: m.ol, section: m.section };

/**
 * Parent that staggers its <StaggerItem> children in. Children are visible on SSR; the hidden state applies only
 * after hydration to groups that are below the fold (in-view groups at mount render without animation).
 */
export function Stagger({ children, className, as = "div", gap = motionTokens.stagger, delay = 0, inView = true, margin = "-60px", id }: StaggerProps) {
  const Tag = parts[as];
  const ref = useRef<HTMLDivElement>(null);
  const phase = useRevealPhase(ref);
  const variants: Variants = { hidden: {}, show: { transition: { staggerChildren: gap, delayChildren: delay } } };
  // key remounts the (below-the-fold) group once when it turns out to need the hidden state: motion ignores later `initial` changes.
  const key = phase === "hidden" && inView ? "hidden" : "visible";
  const common = { id, className, variants, ref: ref as never } as const;
  // Before hydration / when already in view / inView=false: render the final state with no hidden phase (content never invisible).
  if (key === "visible") return <Tag key={key} {...common} initial={false} animate="show">{children}</Tag>;
  return (
    <Tag key={key} {...common} initial="hidden" whileInView="show" viewport={{ once: true, margin }}>{children}</Tag>
  );
}

export type StaggerItemProps = {
  children?: ReactNode;
  className?: string;
  as?: "div" | "li" | "p" | "span" | "article";
  /** Rise distance in px. Default 12. */
  y?: number;
};
const itemParts = { div: m.div, li: m.li, p: m.p, span: m.span, article: m.article };

/** Child of <Stagger>: fades + rises. Reduced motion = opacity only. */
export function StaggerItem({ children, className, as = "div", y = motionTokens.distance.md }: StaggerItemProps) {
  const Tag = itemParts[as];
  const dur = useMotionDuration(motionTokens.duration.slow);
  const item: Variants = {
    hidden: { opacity: 0, y },
    show: { opacity: 1, y: 0, transition: { duration: dur, ease: motionTokens.easing.smooth } },
  };
  return <Tag data-reveal className={className} variants={item}>{children}</Tag>;
}

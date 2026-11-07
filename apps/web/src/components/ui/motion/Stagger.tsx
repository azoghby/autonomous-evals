"use client";
import { m, type Variants } from "motion/react";
import type { ReactNode } from "react";
import { motionTokens } from "./tokens";
import { useMotionDuration } from "./useMotionOk";

export type StaggerProps = {
  children?: ReactNode;
  className?: string;
  as?: "div" | "ul" | "ol" | "section";
  /** Seconds between children. Default motionTokens.stagger (0.08). */
  gap?: number;
  /** Seconds before the first child. */
  delay?: number;
  /** Animate on scroll into view (default true) or immediately on mount (false). */
  inView?: boolean;
  margin?: string;
  id?: string;
};

const parts = { div: m.div, ul: m.ul, ol: m.ol, section: m.section };

/** Parent that staggers its <StaggerItem> children in. */
export function Stagger({ children, className, as = "div", gap = motionTokens.stagger, delay = 0, inView = true, margin = "-60px", id }: StaggerProps) {
  const Tag = parts[as];
  const variants: Variants = { hidden: {}, show: { transition: { staggerChildren: gap, delayChildren: delay } } };
  const common = { id, className, variants, initial: "hidden" as const };
  return inView ? (
    <Tag {...common} whileInView="show" viewport={{ once: true, margin }}>{children}</Tag>
  ) : (
    <Tag {...common} animate="show">{children}</Tag>
  );
}

export type StaggerItemProps = {
  children?: ReactNode;
  className?: string;
  as?: "div" | "li" | "p" | "span" | "article";
  /** Rise distance in px. */
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

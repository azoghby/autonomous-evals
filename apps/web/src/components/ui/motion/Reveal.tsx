"use client";
import { motion } from "motion/react";
import type { CSSProperties, ElementType, ReactNode } from "react";
import { motionTokens } from "./tokens";
import { useMotionDuration } from "./useMotionOk";

const MotionTags = {
  div: motion.div, section: motion.section, li: motion.li, ul: motion.ul, ol: motion.ol,
  p: motion.p, h2: motion.h2, h3: motion.h3, article: motion.article, header: motion.header, span: motion.span,
} as const;
export type RevealTag = keyof typeof MotionTags;

export type RevealProps = {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Element to render. Default "div". */
  as?: RevealTag;
  /** Seconds before the reveal starts. */
  delay?: number;
  /** Rise distance in px (ignored under reduced motion; opacity-only fade). */
  y?: number;
  /** Seconds. Default motionTokens.duration.slow. */
  duration?: number;
  /** IntersectionObserver rootMargin offset; default "-60px". */
  margin?: string;
};

/** Fade + rise once when scrolled into view. SSR-safe; reduced motion = opacity only (see globals.css [data-reveal]). */
export function Reveal({ children, className, style, as = "div", delay = 0, y = motionTokens.distance.lg, duration, margin = "-60px" }: RevealProps) {
  const dur = useMotionDuration(duration ?? motionTokens.duration.slow);
  const Tag = MotionTags[as] as ElementType;
  return (
    <Tag
      data-reveal
      className={className}
      style={style}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin }}
      transition={{ duration: dur, delay, ease: motionTokens.easing.smooth }}
    >
      {children}
    </Tag>
  );
}

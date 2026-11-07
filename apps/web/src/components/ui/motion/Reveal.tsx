"use client";
import { m } from "motion/react";
import type { CSSProperties, ElementType, ReactNode } from "react";
import { motionTokens } from "./tokens";
import { useMotionDuration } from "./useMotionOk";

const MotionTags = {
  div: m.div, section: m.section, li: m.li, ul: m.ul, ol: m.ol,
  p: m.p, h2: m.h2, h3: m.h3, article: m.article, header: m.header, span: m.span,
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

"use client";
import { m } from "motion/react";
import { useRef, type CSSProperties, type ElementType, type ReactNode } from "react";
import { motionTokens } from "./tokens";
import { useMotionDuration } from "./useMotionOk";
import { useRevealPhase } from "./useInitialInView";

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
  /** Rise distance in px (ignored under reduced motion; opacity-only fade). Default 12. */
  y?: number;
  /** Seconds. Default motionTokens.duration.slow. */
  duration?: number;
  /** IntersectionObserver rootMargin offset; default "-60px". */
  margin?: string;
};

/**
 * Fade + rise once when scrolled into view. Content is visible on SSR / without JS; the hidden state is only
 * applied after hydration and only for elements that are below the fold at mount (so no flash, no blank bands).
 */
export function Reveal({ children, className, style, as = "div", delay = 0, y = motionTokens.distance.md, duration, margin = "-60px" }: RevealProps) {
  const dur = useMotionDuration(duration ?? motionTokens.duration.slow);
  const Tag = MotionTags[as] as ElementType;
  const ref = useRef<HTMLElement>(null);
  const phase = useRevealPhase(ref);
  const hide = phase === "hidden";
  return (
    <Tag
      key={hide ? "hidden" : "visible"}
      ref={ref}
      data-reveal
      className={className}
      style={style}
      {...(hide
        ? { initial: { opacity: 0, y }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true, margin } }
        : { initial: false, animate: { opacity: 1, y: 0 } })}
      transition={{ duration: dur, delay, ease: motionTokens.easing.smooth }}
    >
      {children}
    </Tag>
  );
}

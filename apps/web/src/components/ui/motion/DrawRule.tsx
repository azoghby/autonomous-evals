"use client";
import { motion } from "motion/react";
import { cn } from "../cn";
import { motionTokens } from "./tokens";
import { useMotionDuration } from "./useMotionOk";

/** Hairline that draws left-to-right (scaleX) when scrolled into view. Reduced motion = fade. */
export function DrawRule({ className, delay = 0 }: { className?: string; delay?: number }) {
  const dur = useMotionDuration(motionTokens.duration.crawl);
  return (
    <motion.span
      aria-hidden
      data-rule
      className={cn("block h-px w-full origin-left bg-current", className)}
      initial={{ scaleX: 0, opacity: 0 }}
      whileInView={{ scaleX: 1, opacity: 1 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: dur, delay, ease: motionTokens.easing.smooth }}
    />
  );
}
